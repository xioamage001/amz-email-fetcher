const Imap = require('imap');
const { simpleParser } = require('mailparser');
const fetch = require('node-fetch');
const Papa = require('papaparse');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

const supabase = createClient(config.supabase.url, config.supabase.anonKey);

function log(msg) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[${time}] ${msg}`);
}

// ========== 多租户：从数据库读取所有启用了邮箱拉取的租户配置 ==========
async function fetchAllTenantEmailConfigs() {
  log('正在从数据库读取所有租户的邮箱配置...');

  // 1. 读取所有租户
  const { data: tenants, error: tenantError } = await supabase
    .from('amazon_ads_tenants')
    .select('id, tenant_code, tenant_name, status');

  if (tenantError) throw new Error('读取租户列表失败: ' + tenantError.message);
  log(`共找到 ${tenants.length} 个租户`);

  // 2. 读取所有用户配置（筛选启用了邮箱拉取且有配置的）
  const { data: configs, error: configError } = await supabase
    .from('amazon_ads_user_configs')
    .select('user_id, email_enabled, email_config')
    .eq('email_enabled', true)
    .not('email_config', 'is', null);

  if (configError) throw new Error('读取邮箱配置失败: ' + configError.message);
  log(`共找到 ${configs.length} 个启用了邮箱拉取的配置`);

  // 3. 关联租户ID，组装成拉取任务列表
  const tasks = [];
  for (const cfg of configs) {
    const tenant = tenants.find(t => t.tenant_code === cfg.user_id);
    if (!tenant) {
      log(`⚠️  配置 user_id=${cfg.user_id} 未找到对应租户，跳过`);
      continue;
    }
    if (tenant.status !== 'active') {
      log(`⚠️  租户 ${tenant.tenant_name} 状态非active，跳过`);
      continue;
    }
    if (!cfg.email_config || !cfg.email_config.email || !cfg.email_config.password) {
      log(`⚠️  租户 ${tenant.tenant_name} 邮箱配置不完整，跳过`);
      continue;
    }
    tasks.push({
      tenantId: tenant.id,
      tenantCode: tenant.tenant_code,
      tenantName: tenant.tenant_name,
      userId: cfg.user_id,
      email: cfg.email_config.email,
      password: cfg.email_config.password,
      host: cfg.email_config.host || inferImapHost(cfg.email_config.email),
      port: parseInt(cfg.email_config.port || '993'),
      tls: cfg.email_config.tls !== false,
    });
  }

  log(`组装完成，共 ${tasks.length} 个租户需要拉取`);
  tasks.forEach(t => log(`  - ${t.tenantName} (${t.tenantCode}): ${t.email}`));
  return tasks;
}

// 根据邮箱域名推断 IMAP 服务器（host 为空时兜底）
function inferImapHost(email) {
  const domain = String(email || '').split('@')[1] || '';
  const map = {
    '163.com': 'imap.163.com',
    '126.com': 'imap.126.com',
    'yeah.net': 'imap.yeah.net',
    '188.com': 'imap.188.com',
    'qq.com': 'imap.qq.com',
    'foxmail.com': 'imap.qq.com',
    'gmail.com': 'imap.gmail.com',
    'outlook.com': 'outlook.office365.com',
    'hotmail.com': 'outlook.office365.com',
    'yahoo.com': 'imap.mail.yahoo.com',
  };
  return map[domain.toLowerCase()] || 'imap.163.com';
}

// 创建 IMAP 连接。
// 关键：网易(163/126/yeah/188) 对境外/数据中心 IP（如 GitHub Actions 海外 runner）
// 要求在 LOGIN 认证【之前】先发送 IMAP ID 标识客户端，否则直接拒绝并报
// "LOGIN Login error or password error / Unsafe Login"。node-imap 默认登录后才发 ID，
// 这里拦截队列里第一个 LOGIN 命令，在它前面插入 ID 命令，实现“先 ID 后登录”。
function createImap(tenantConfig) {
  const host = tenantConfig.host || inferImapHost(tenantConfig.email);
  const imap = new Imap({
    user: tenantConfig.email,
    password: tenantConfig.password,
    host,
    port: tenantConfig.port || 993,
    tls: tenantConfig.tls !== false,
    connTimeout: 30000,
    authTimeout: 30000,
  });
  const idArgs = `("name" "amz-email-fetcher" "version" "3.1-multitenant" "vendor" "amzAI" "contact" "${tenantConfig.email}")`;
  const origEnqueue = imap._enqueue;
  let injected = false;
  imap._enqueue = function (cmd, cb) {
    if (!injected && typeof cmd === 'string' && cmd.indexOf('LOGIN ') === 0) {
      injected = true;
      return origEnqueue.call(this, 'ID ' + idArgs, () => origEnqueue.call(this, cmd, cb));
    }
    return origEnqueue.call(this, cmd, cb);
  };
  imap._inferredHost = host;
  return imap;
}

// ========== 邮箱搜索（按租户配置） ==========
function searchEmails(tenantConfig) {
  return new Promise((resolve, reject) => {
    const imap = createImap(tenantConfig);

    imap.once('ready', () => {
      log(`[${tenantConfig.tenantName}] 邮箱连接成功，发送IMAP ID标识...`);
      imap.id({
        name: 'amz-email-fetcher',
        version: '2.0-multitenant',
        vendor: 'amzAI',
        contact: tenantConfig.email
      }, () => {
        log(`[${tenantConfig.tenantName}] IMAP ID标识已发送，开始搜索邮件...`);
        imap.openBox('INBOX', true, (err, box) => {
          if (err) {
            imap.end();
            return reject(new Error('打开收件箱失败: ' + err.message));
          }

          const sinceDate = new Date();
          sinceDate.setDate(sinceDate.getDate() - config.filter.days);
          const sinceStr = sinceDate.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });

          imap.search([['SINCE', sinceStr]], (err, uids) => {
            if (err) {
              imap.end();
              return reject(new Error('搜索邮件失败: ' + err.message));
            }

            if (!uids || uids.length === 0) {
              imap.end();
              return resolve([]);
            }

            const f = imap.fetch(uids, { bodies: '', struct: true });
            const emails = [];
            let pending = 0;
            let done = false;

            f.on('message', (msg, seqno) => {
              pending++;
              msg.on('body', (stream, info) => {
                simpleParser(stream, async (err, parsed) => {
                  if (err) {
                    log(`[${tenantConfig.tenantName}] 解析邮件失败: ` + err.message);
                    pending--;
                    if (pending === 0 && done) finish();
                    return;
                  }

                  const from = (parsed.from && parsed.from.text) || '';
                  const subject = parsed.subject || '';
                  const date = parsed.date || new Date();
                  const html = parsed.html || '';
                  const text = parsed.text || '';

                  if (from.toLowerCase().includes(config.filter.sender.toLowerCase()) &&
                      subject.toLowerCase().includes(config.filter.subject.toLowerCase())) {
                    log(`[${tenantConfig.tenantName}] 找到匹配邮件: ${subject} (${from})`);
                    emails.push({ from, subject, date, html, text });
                  }

                  pending--;
                  if (pending === 0 && done) finish();
                });
              });
            });

            f.once('error', (err) => {
              imap.end();
              reject(new Error('获取邮件失败: ' + err.message));
            });

            f.once('end', () => {
              done = true;
              if (pending === 0) finish();
            });

            function finish() {
              imap.end();
              // 按发送时间【从旧到新】排序：处理时新邮件在后，配合“整体替换”确保最新报告最终覆盖旧报告，
              // 避免旧邮件（归因回溯更少）覆盖新邮件，导致订单/销售额回退。
              emails.sort((a, b) => new Date(a.date) - new Date(b.date));
              resolve(emails);
            }
          });
        });
      });
    });

    imap.once('error', (err) => {
      const msg = err.message || '';
      if (/LOGIN|password|authenticate|Unsafe|auth/i.test(msg)) {
        return reject(new Error(
          `邮箱认证失败（${msg}）。请检查：1) 授权码是否正确（注意是邮箱IMAP授权码，不是登录密码）；2) 邮箱是否已开启 IMAP/SMTP 服务；3) IMAP服务器 host=${imap._inferredHost}。`
        ));
      }
      reject(new Error('邮箱连接失败: ' + msg));
    });

    imap.once('end', () => {
      log(`[${tenantConfig.tenantName}] 邮箱连接已关闭`);
    });

    imap.connect();
  });
}

function extractDownloadLink(email) {
  const $ = cheerio.load(email.html);
  let link = null;
  $('a').each((i, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr('href');
    if (href && (text.includes('下载') || text.includes('Download') || text.includes('报告') || text.includes('report'))) {
      link = href;
      return false;
    }
  });
  if (!link) {
    $('a').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('amazon') || href.includes('aws') || href.includes('s3')) {
        link = href;
        return false;
      }
    });
  }
  if (!link && email.text) {
    const urlMatch = email.text.match(/https?:\/\/[^\s<>"']+/);
    if (urlMatch) link = urlMatch[0];
  }
  return link;
}

// 从CSV行数据的"日期"列提取数据日期（格式：2026年9月10日 → 2026-09-10）
// 注意：邮件主题里的日期是报告生成时间，不是数据日期，必须从CSV内容提取
function extractDatesFromRows(rows) {
  const dateSet = new Set();
  for (const row of rows) {
    const dateStr = row['日期'] || row['Date'] || '';
    if (!dateStr) continue;
    // 匹配 "2026年9月10日" 格式
    const match = dateStr.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (match) {
      const y = match[1];
      const m = match[2].padStart(2, '0');
      const d = match[3].padStart(2, '0');
      dateSet.add(`${y}-${m}-${d}`);
    }
  }
  return Array.from(dateSet).sort();
}

// 按日期分组行数据
function groupRowsByDate(rows) {
  const groups = {};
  for (const row of rows) {
    const dateStr = row['日期'] || row['Date'] || '';
    const match = dateStr.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    let dateKey;
    if (match) {
      dateKey = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    } else {
      // 没有日期列的行，归入当天
      dateKey = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
    }
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(row);
  }
  return groups;
}

async function downloadCSV(url) {
  log('正在下载报告: ' + url.substring(0, 80) + '...');
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 60000,
  });
  if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`);
  const text = await response.text();
  log(`下载成功，文件大小: ${text.length} 字节`);
  return text;
}

function parseCSV(csvText) {
  return new Promise((resolve, reject) => {
    Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => resolve(results.data),
      error: (err) => reject(err),
    });
  });
}

// ========== 小时级报表按天聚合 ==========
// 亚马逊搜索词报告若在后台选了“按小时”，同一天同一搜索词/活动/广告组会按 0-23 点拆成多行。
// 旧逻辑只按“搜索词_活动_广告组”去重，会把不同小时行互相覆盖，导致行数变少、花费/订单/销售额严重偏小。
// 这里在入库前把小时明细聚合为按天数据：计数/金额求和，比率(CTR/CPC/CVR/ROAS/CPM)按聚合后重算。
function normNum(v) {
  if (v === null || v === undefined) return 0;
  let s = String(v).trim();
  if (s === '' || s === '-' || s === '--' || s === 'N/A') return 0;
  s = s.replace(/[,$€£¥%\s]/g, '');
  if (/^="/.test(s) && /"$/.test(s)) s = s.slice(2, -1);
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}
function isNumericCell(v) {
  if (v === null || v === undefined) return false;
  let s = String(v).trim();
  if (s === '' || s === '-' || s === '--') return false;
  s = s.replace(/[,$€£¥%\s]/g, '');
  if (/^="/.test(s) && /"$/.test(s)) s = s.slice(2, -1);
  if (s === '') return false;
  return !isNaN(Number(s));
}
function pickCol(headers, patterns) {
  for (const p of patterns) { const c = headers.find(h => h === p); if (c) return c; }
  for (const p of patterns) { const c = headers.find(h => typeof h === 'string' && h.includes(p)); if (c) return c; }
  return null;
}
const RATIO_COL_RE = /率|占比|平均|每|单次|单价|CPM|CPC|CPA|ROAS|ACOS|%|CTR|CVR|回报|价值平均/;
const TIME_COL_RE = /^(小时|日期|周|月|年份|月中的一天|一周中的某一天|Hour|Day|Week|Month|Year)$/;
const ID_TEXT_COL_RE = /编号|ID|SKU|代码|货币|国家|地区|城市|邮政|区域|设备|浏览器|操作系统|版本|格式|尺寸|语言|类型|状态|名称|分类|品牌|品类|父级|站点|广告主|管理员|网站|方案|广告位|时间|星期|环境|广告产品|匹配|搜索词|投放|广告组|广告活动|推广|广告组合|交易|目标竞价|广告 ?ID/;

// 搜索词报告“按天”的业务唯一键（用于小时聚合、以及跨来源合并）
function businessKey(headers, row) {
  const g = (names) => {
    for (const n of names) {
      const c = headers.find(h => h === n || (typeof h === 'string' && h.includes(n)));
      if (c && row[c] !== undefined && String(row[c]).trim() !== '') return String(row[c]);
    }
    return '';
  };
  return [
    g(['搜索词', 'Search term']),
    g(['广告活动编号', '广告活动名称', 'Campaign ID', 'Campaign Name']),
    g(['广告组编号', '广告组名称', 'Ad Group ID', 'Ad Group Name']),
    g(['投放匹配类型', '匹配类型', 'Match type']),
    g(['推广的商品编号', '推广商品编号', 'Advertised ASIN']),
  ].join('|');
}

function aggregateRowsIfHourly(rows) {
  if (!rows || rows.length === 0) return rows;
  const headers = Object.keys(rows[0]);
  const hourCol = headers.find(h => h === '小时' || /^Hour$/i.test(h));
  const hasHourly = hourCol && rows.some(r => String(r[hourCol] ?? '').trim() !== '');
  if (!hasHourly) {
    log('报表为按天粒度，无需按天聚合');
    return rows;
  }
  log(`检测到【小时级】报表，开始按天聚合 ${rows.length} 行小时明细...`);

  // 分类列：数值型 -> 可加 / 比率；其余为维度
  const additive = [];
  const ratio = [];
  headers.forEach(h => {
    if (TIME_COL_RE.test(h)) return;
    let nonEmpty = 0, numCnt = 0;
    for (const r of rows) {
      const v = r[h];
      if (v !== null && v !== undefined && String(v).trim() !== '') { nonEmpty++; if (isNumericCell(v)) numCnt++; }
    }
    if (nonEmpty > 0 && numCnt / nonEmpty >= 0.85) {
      if (RATIO_COL_RE.test(h)) ratio.push(h);
      else if (ID_TEXT_COL_RE.test(h)) { /* 数字型编号/计数代码，不参与求和 */ }
      else additive.push(h);
    }
  });

  const dateCol = pickCol(headers, ['日期', 'Date']);
  const keyCols = [
    pickCol(headers, ['搜索词', 'Search term']),
    pickCol(headers, ['广告活动编号', '广告活动名称', 'Campaign ID', 'Campaign Name']),
    pickCol(headers, ['广告组编号', '广告组名称', 'Ad Group ID', 'Ad Group Name']),
    pickCol(headers, ['投放匹配类型', '匹配类型', 'Match type']),
    pickCol(headers, ['推广的商品编号', '推广商品编号', 'Advertised ASIN']),
  ].filter(Boolean);

  const C = {
    impr: pickCol(headers, ['展示量', 'Impressions']),
    clicks: pickCol(headers, ['点击量', 'Clicks']),
    spend: pickCol(headers, ['总成本（已转换）', '总成本（已换算）', '总成本', 'Spend']),
    orders: pickCol(headers, ['归因于点击的购买量', '购买量', 'Orders']),
    sales: pickCol(headers, ['归因于点击的销售额（已换算）', '销售额（已换算）', '归因于点击的销售额', '销售额', 'Sales']),
    ctr: pickCol(headers, ['点击率']),
    cpc: pickCol(headers, ['每次点击费用（已转换）', '每次点击费用（已换算）', '每次点击费用']),
    cvr: pickCol(headers, ['点击转化率']),
    prate: pickCol(headers, ['点击购买率', '购买率（推广的商品）']),
    roas: pickCol(headers, ['归因于点击的 ROAS', 'ROAS']),
    cpm: pickCol(headers, ['媒体支出 CPM', 'CPM']),
  };
  const recomputedCols = new Set(Object.values(C).filter(Boolean));

  function dateKeyOf(r) {
    const d = r[dateCol] || '';
    let m = String(d).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = String(d).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return String(d);
  }

  const map = new Map();
  for (const r of rows) {
    const dk = dateKeyOf(r);
    const key = dk + '|' + keyCols.map(c => r[c] ?? '').join('|');
    if (!map.has(key)) {
      const base = { ...r };
      if (hourCol) base[hourCol] = ''; // 全天聚合，清空小时
      const sums = {};
      additive.forEach(c => sums[c] = 0);
      map.set(key, { base, sums, dk });
    }
    const g = map.get(key);
    additive.forEach(c => g.sums[c] += normNum(r[c]));
  }

  const out = [];
  for (const g of map.values()) {
    const row = g.base;
    additive.forEach(c => {
      const v = g.sums[c];
      row[c] = /量|次数|个数|点击|展示|购买|订单|数量|安装|启动|调用|启用|借阅|加购|搜索|浏览|播放|订阅|申请|注册|结账|联系|心愿|清单|页/.test(c)
        ? Math.round(v) : Math.round(v * 100) / 100;
    });
    ratio.forEach(c => { if (!recomputedCols.has(c)) row[c] = ''; }); // 非核心比率置空，避免错误相加
    // 核心比率按聚合后的总量重算
    const impr = normNum(row[C.impr]), clicks = normNum(row[C.clicks]),
          spend = normNum(row[C.spend]), orders = normNum(row[C.orders]), sales = normNum(row[C.sales]);
    if (C.ctr) row[C.ctr] = impr > 0 ? (clicks / impr * 100).toFixed(2) + '%' : '';
    if (C.cpc) row[C.cpc] = clicks > 0 ? (spend / clicks).toFixed(2) : '';
    if (C.cvr) row[C.cvr] = clicks > 0 ? (orders / clicks * 100).toFixed(2) + '%' : '';
    if (C.prate) row[C.prate] = clicks > 0 ? (orders / clicks * 100).toFixed(2) + '%' : '';
    if (C.roas) row[C.roas] = spend > 0 ? (sales / spend).toFixed(2) : '';
    if (C.cpm) row[C.cpm] = impr > 0 ? (spend / impr * 1000).toFixed(2) : '';
    out.push(row);
  }

  const stat = {};
  rows.forEach(r => { const dk = dateKeyOf(r); stat[dk] = stat[dk] || { raw: 0, agg: 0 }; stat[dk].raw++; });
  out.forEach(r => { const dk = dateKeyOf(r); stat[dk] && stat[dk].agg++; });
  Object.keys(stat).sort().forEach(dk => log(`  ${dk}: 小时明细 ${stat[dk].raw} 行 → 按天聚合 ${stat[dk].agg} 行`));
  log(`按天聚合完成，共 ${out.length} 行（原 ${rows.length} 行小时明细）`);
  return out;
}

// ========== 存储到Supabase（按租户隔离） ==========
async function saveToSupabase(tenantConfig, dateKey, rows, fileName, forceOverwrite) {
  log(`[${tenantConfig.tenantName}] 正在存储数据: date=${dateKey}, rows=${rows.length}${forceOverwrite ? '（强制覆盖）' : ''}`);

  const { data: existing, error: queryError } = await supabase
    .from(config.tableName)
    .select('*')
    .eq('tenant_id', tenantConfig.tenantId)
    .eq('date_key', dateKey)
    .single();

  if (queryError && queryError.code !== 'PGRST116') {
    throw new Error('查询已有数据失败: ' + queryError.message);
  }

  let mergedRows = rows;
  let source = forceOverwrite ? 'email_auto_merged' : 'email_auto';

  if (forceOverwrite) {
    // 权威策略：最新一封“每天更新”报告含最近7天完整全量，对窗口内每个日期无条件整体替换，
    // 不与任何旧的片段/小时/手动数据合并，避免残缺邮件把完整数据覆盖成零星几行。
    log(`[${tenantConfig.tenantName}] 强制覆盖 ${dateKey}：最新报告 ${rows.length} 行整体替换（旧 ${existing && existing.raw_data ? existing.raw_data.length : 0} 行丢弃）`);
  } else if (existing && existing.raw_data && existing.raw_data.length > 0) {
    const isEmail = (existing.source || '').startsWith('email_auto');
    if (isEmail) {
      // 邮件报表是该日期的权威滚动全量（包含历史归因回溯），直接整体替换，
      // 避免旧的残缺/小时重复数据按错误 key 残留，导致行数翻倍或指标偏小
      log(`[${tenantConfig.tenantName}] 当天已有 ${existing.raw_data.length} 行（邮件来源），用最新报表整体替换`);
      mergedRows = rows;
      source = 'email_auto_merged';
    } else {
      // 手动上传来源：按业务键合并，保留手动数据独有的行
      const headers = rows.length
        ? Object.keys(rows[0])
        : (existing.raw_data.length ? Object.keys(existing.raw_data[0]) : []);
      const map = new Map();
      existing.raw_data.forEach(r => map.set(businessKey(headers, r), r));
      rows.forEach(r => map.set(businessKey(headers, r), r));
      mergedRows = Array.from(map.values());
      source = 'email_auto_merged';
      log(`[${tenantConfig.tenantName}] 与手动数据合并，共 ${mergedRows.length} 行（手动 ${existing.raw_data.length} 行，邮件 ${rows.length} 行）`);
    }
  }

  // 计算汇总指标（动态定位列，兼容新旧报表列名）
  const allHeaders = mergedRows.length ? Object.keys(mergedRows[0]) : [];
  const sCol = {
    impr: pickCol(allHeaders, ['展示量', 'Impressions']),
    clicks: pickCol(allHeaders, ['点击量', 'Clicks']),
    spend: pickCol(allHeaders, ['总成本（已转换）', '总成本（已换算）', '总成本', 'Spend']),
    orders: pickCol(allHeaders, ['归因于点击的购买量', '购买量', 'Orders']),
    sales: pickCol(allHeaders, ['归因于点击的销售额（已换算）', '销售额（已换算）', '归因于点击的销售额', '销售额', 'Sales']),
  };
  let totalSpend = 0, totalClicks = 0, totalOrders = 0, totalSales = 0, totalImpr = 0;
  mergedRows.forEach(row => {
    totalSpend += normNum(sCol.spend ? row[sCol.spend] : 0);
    totalClicks += normNum(sCol.clicks ? row[sCol.clicks] : 0);
    totalOrders += normNum(sCol.orders ? row[sCol.orders] : 0);
    totalSales += normNum(sCol.sales ? row[sCol.sales] : 0);
    totalImpr += normNum(sCol.impr ? row[sCol.impr] : 0);
  });

  const record = {
    tenant_id: tenantConfig.tenantId,
    user_id: tenantConfig.userId,
    date_key: dateKey,
    file_name: fileName,
    source: source,
    total_rows: mergedRows.length,
    total_columns: mergedRows.length > 0 ? Object.keys(mergedRows[0]).length : 0,
    raw_data: mergedRows,
    summary: {
      impressions: totalImpr,
      spend: Math.round(totalSpend * 100) / 100,
      clicks: totalClicks,
      orders: totalOrders,
      sales: Math.round(totalSales * 100) / 100,
      ctr: totalImpr > 0 ? Math.round(totalClicks / totalImpr * 10000) / 100 : 0,
      cpc: totalClicks > 0 ? Math.round(totalSpend / totalClicks * 100) / 100 : 0,
      acos: totalSales > 0 ? Math.round(totalSpend / totalSales * 1000) / 10 : 0,
      cvr: totalClicks > 0 ? Math.round(totalOrders / totalClicks * 1000) / 10 : 0,
    },
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { error: updateError } = await supabase
      .from(config.tableName)
      .update(record)
      .eq('tenant_id', tenantConfig.tenantId)
      .eq('date_key', dateKey);
    if (updateError) throw new Error('更新数据失败: ' + updateError.message);
  } else {
    record.created_at = new Date().toISOString();
    const { error: insertError } = await supabase
      .from(config.tableName)
      .insert(record);
    if (insertError) throw new Error('插入数据失败: ' + insertError.message);
  }

  log(`[${tenantConfig.tenantName}] 数据存储成功: ${dateKey}, 共 ${mergedRows.length} 行`);
  return mergedRows.length;
}

async function processEmail(tenantConfig, email) {
  log(`[${tenantConfig.tenantName}] 处理邮件: ${email.subject}`);

  const downloadUrl = extractDownloadLink(email);
  if (!downloadUrl) throw new Error(`未找到下载链接: ${email.subject}`);

  const csvText = await downloadCSV(downloadUrl);
  const parsedRows = await parseCSV(csvText);
  log(`[${tenantConfig.tenantName}] CSV解析完成: ${parsedRows.length} 行, ${parsedRows.length > 0 ? Object.keys(parsedRows[0]).length : 0} 列`);
  if (parsedRows.length === 0) throw new Error('CSV解析后无数据');

  // 小时级报表（含“小时”列）按天聚合，避免同搜索词不同小时行被错误去重导致行数/指标偏小
  const rows = aggregateRowsIfHourly(parsedRows);

  // 从CSV内容提取数据日期（不再用邮件主题的日期）
  const dates = extractDatesFromRows(rows);
  log(`[${tenantConfig.tenantName}] CSV中包含的数据日期: ${dates.join(', ') || '未找到日期列'}`);

  if (dates.length === 0) {
    // 没有日期列，用当天日期兜底
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
    log(`[${tenantConfig.tenantName}] 未找到日期列，使用当天日期 ${today}`);
    const fileName = `Search_term_${today}.csv`;
    const count = await saveToSupabase(tenantConfig, today, rows, fileName);
    return [{ dateKey: today, rowCount: count }];
  }

  // 按日期拆分存储
  const groups = groupRowsByDate(rows);
  const results = [];
  for (const [dateKey, dateRows] of Object.entries(groups)) {
    const fileName = `Search_term_${dateKey}.csv`;
    const count = await saveToSupabase(tenantConfig, dateKey, dateRows, fileName);
    results.push({ dateKey, rowCount: count });
  }
  return results;
}

// ========== 单个租户的拉取流程 ==========
async function fetchReportsForTenant(tenantConfig) {
  log(`========== 开始拉取租户 [${tenantConfig.tenantName}] 的报告 ==========`);
  try {
    const emails = await searchEmails(tenantConfig);
    log(`[${tenantConfig.tenantName}] 共找到 ${emails.length} 封匹配邮件`);

    if (emails.length === 0) {
      return { success: true, tenant: tenantConfig.tenantName, emailCount: 0, message: '未找到匹配的报告邮件' };
    }

    // 权威策略：邮件“每天更新”，每封含最近7天完整全量、窗口每天平移一天。
    // 只采用【最新一封能成功下载并解析的完整报告】，对其窗口内全部日期强制覆盖；
    // 其余邮件（可能是只含少数搜索词/单广告位的片段，或下载链接已过期）一律不入库，
    // 避免片段邮件在完整报告之后写入、把完整数据覆盖成零星几行。
    emails.sort((a, b) => new Date(b.date) - new Date(a.date)); // 新→旧
    log(`[${tenantConfig.tenantName}] 按发送时间新→旧依次尝试，只采用第一封完整报告`);

    let authoritative = null;
    const tryErrors = [];
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      try {
        const downloadUrl = extractDownloadLink(email);
        if (!downloadUrl) throw new Error('未找到下载链接');
        const csvText = await downloadCSV(downloadUrl);
        const parsedRows = await parseCSV(csvText);
        if (parsedRows.length === 0) throw new Error('CSV解析后无数据');
        const rows = aggregateRowsIfHourly(parsedRows);
        const dates = extractDatesFromRows(rows);
        if (dates.length === 0) throw new Error('未找到日期列');
        authoritative = { email, groups: groupRowsByDate(rows), dates };
        log(`[${tenantConfig.tenantName}] ✓ 采用最新有效报告：${email.subject}，覆盖日期 ${dates.join(', ')}`);
        break;
      } catch (err) {
        log(`[${tenantConfig.tenantName}] 邮件[${i + 1}]不可用（尝试更早一封）：${err.message}`);
        tryErrors.push({ email: email.subject, error: err.message });
      }
    }

    if (!authoritative) {
      return { success: false, tenant: tenantConfig.tenantName, emailCount: emails.length, error: '没有可成功下载的完整报告（多为下载链接过期/HTTP 403）' };
    }

    // 对权威报告窗口内的全部日期，强制覆盖
    const results = [];
    for (const [dateKey, dateRows] of Object.entries(authoritative.groups)) {
      const count = await saveToSupabase(tenantConfig, dateKey, dateRows, `Search_term_${dateKey}.csv`, true);
      results.push({ dateKey, rowCount: count });
    }

    return {
      success: true,
      partial: tryErrors.length > 0,
      tenant: tenantConfig.tenantName,
      emailCount: emails.length,
      processed: results.length,
      failedEmail: tryErrors.length,
      results,
      warnings: tryErrors,
    };
  } catch (error) {
    log(`[${tenantConfig.tenantName}] 拉取失败: ${error.message}`);
    return { success: false, tenant: tenantConfig.tenantName, error: error.message };
  }
}

// ========== 主流程：多租户循环拉取 ==========
async function main() {
  const startTime = new Date();
  log('==================================================');
  log('亚马逊广告AI分析助手 - 多租户邮箱自动拉取服务 v3.0');
  log(`Supabase: ${config.supabase.url}`);
  log(`数据表: ${config.tableName}`);
  log(`邮件筛选: 发件人含"${config.filter.sender}", 主题含"${config.filter.subject}", 最近${config.filter.days}天`);
  log('==================================================');

  try {
    // 1. 读取所有租户的邮箱配置
    const tenantTasks = await fetchAllTenantEmailConfigs();

    if (tenantTasks.length === 0) {
      log('没有租户启用邮箱拉取，任务结束');
      console.log('::set-output name=result::' + JSON.stringify({ success: true, message: '没有启用邮箱拉取的租户' }));
      process.exit(0);
    }

    // 2. 循环每个租户拉取
    const allResults = [];
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalPartial = 0;

    for (const tenantConfig of tenantTasks) {
      log('');
      const result = await fetchReportsForTenant(tenantConfig);
      allResults.push(result);
      if (result.success) {
        totalSuccess++;
        if (result.partial) totalPartial++;
      } else {
        totalFailed++;
      }
      // 租户之间间隔2秒，避免IMAP连接过于频繁
      if (tenantTasks.indexOf(tenantConfig) < tenantTasks.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    const duration = ((new Date() - startTime) / 1000).toFixed(1);
    log('');
    log('==================================================');
    log(`全部拉取完成: 成功 ${totalSuccess}/${tenantTasks.length} 个租户, 失败 ${totalFailed} 个, 部分成功 ${totalPartial} 个, 总耗时 ${duration} 秒`);
    allResults.forEach(r => {
      const status = r.success ? (r.partial ? '⚠️' : '✅') : '❌';
      log(`  ${status} ${r.tenant}: ${r.success ? `处理${r.processed}个日期数据` + (r.partial ? `（${r.failedEmail}封邮件链接过期已跳过）` : '') : r.error || '拉取失败'}`);
    });
    log('==================================================');

    const finalResult = {
      success: totalFailed === 0,
      totalTenants: tenantTasks.length,
      successCount: totalSuccess,
      failedCount: totalFailed,
      partialCount: totalPartial,
      duration: duration + 's',
      results: allResults,
    };

    console.log('::set-output name=result::' + JSON.stringify(finalResult));

    if (totalFailed > 0) {
      console.error('::error::存在租户拉取失败，请查看日志详情');
    } else if (totalPartial > 0) {
      console.log('::warning::部分历史报告邮件下载链接已过期(HTTP 403)，但最新数据已成功同步，不影响结果');
    }
    process.exit(0);
  } catch (error) {
    log('致命错误: ' + error.message);
    console.error('::error::拉取失败: ' + error.message);
    process.exit(1);
  }
}

main();
