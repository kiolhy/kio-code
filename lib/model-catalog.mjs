// 跨账号模型目录：把各账号探测到的 info 合成一张「模型 + 价格」表
//
// 价格是阶梯数组（tiers），同一模型可能被多个账号报告：
//   - 取「首档 input 价」最低的那份（对用户最有利）
//   - tiers 取更完整的那份（档数多者）
//   - 能力标记（queue/promptCache）取并集

function parseInfo(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const firstInput = (m) => (Array.isArray(m?.tiers) && m.tiers.length ? (m.tiers[0].input ?? Infinity) : (m?.price?.input ?? Infinity));

export function buildCatalog(accounts = []) {
  const byId = new Map();
  const list = [];

  for (const a of accounts) {
    const info = parseInfo(a.info);
    const label = a.name ?? a.id;
    list.push({
      id: a.id,
      name: a.name,
      enabled: a.enabled !== false,
      modelCount: info?.modelCount ?? (info?.models?.length ?? 0),
      agentCount: info?.agentCount ?? 0,
      balanceTotal: info?.balanceTotal ?? null,
      checkedAt: info?.checkedAt ?? null,
      errors: info?.errors?.length ?? 0,
      user: info?.user ?? null,
    });

    for (const m of info?.models ?? []) {
      if (!m?.id) continue;
      const cur = byId.get(m.id);
      if (!cur) {
        byId.set(m.id, { ...m, accounts: [label] });
        continue;
      }
      if (!cur.accounts.includes(label)) cur.accounts.push(label);
      // 价格取更低的那份
      if (firstInput(m) < firstInput(cur)) {
        cur.price = m.price;
        cur.tiers = m.tiers;
      }
      // 阶梯更完整的也留下
      if ((m.tiers?.length ?? 0) > (cur.tiers?.length ?? 0)) cur.tiers = m.tiers;
      cur.queue = !!(cur.queue || m.queue);
      cur.promptCache = !!(cur.promptCache || m.promptCache);
      cur.reasoning = !!(cur.reasoning || m.reasoning);
      cur.maxTokens = cur.maxTokens ?? m.maxTokens;
      cur.contextWindow = cur.contextWindow ?? m.contextWindow;
      cur.inputLength = cur.inputLength ?? m.inputLength;
      cur.alias = cur.alias ?? m.alias;
      cur.name = cur.name ?? m.name;
      cur.channel = cur.channel ?? m.channel;
    }
  }

  const models = [...byId.values()]
    .map((m) => ({ ...m, accounts: [...new Set(m.accounts)] }))
    .sort((a, b) => firstInput(a) - firstInput(b) || String(a.id).localeCompare(String(b.id)));

  return { models, accounts: list };
}
