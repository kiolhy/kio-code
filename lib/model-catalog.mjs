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

/**
 * 判断两个模型条目是不是同一个模型。
 *
 * 不同账号对同一个模型报的 id 可能不一样：实测账号 A 报
 *   { id: 'kimi-k3',     name: 'Kimi-K3' }
 * 账号 B 报
 *   { id: 'Kimi-K3' }
 * 只按 id 去重会得到两条，各自只挂一个账号，下游照着某条填就会
 * 被调度到不认这个名字的账号上，上游返回 InferHub.002002009.404。
 *
 * 所以 id 和 name 交叉相等也算同一个。
 */
function sameModel(a, b) {
  if (!a || !b) return false;
  const ids = [a.id, a.name, a.alias].filter(Boolean);
  const other = [b.id, b.name, b.alias].filter(Boolean);
  return ids.some((x) => other.includes(x));
}

/**
 * 挑出「上游真正认」的 id。
 *
 * 实测上游只认 model_id（kimi-k3），不认显示名（Kimi-K3）。
 * 一个条目如果 id 和 name 都存在且不同，id 才是能调通的那个。
 * 若 id 恰好等于另一个条目的 name，说明这个 id 是显示名，要换掉。
 */
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
      // 探测时验证过且明确调不通的，不进目录 —— 否则 /v1/models 会把它
      // 列出来，下游照着填就必然 404（实测某账号 8 个模型只有 1 个能用）
      if (m.usable === false) continue;
      // 先按 id 精确命中，再退化成「id/name 交叉相等」找同款
      let cur = byId.get(m.id);
      if (!cur) {
        for (const v of byId.values()) {
          if (sameModel(v, m)) { cur = v; break; }
        }
      }
      if (!cur) {
        byId.set(m.id, { ...m, accounts: [label], _ids: [m.id] });
        continue;
      }
      if (!cur.accounts.includes(label)) cur.accounts.push(label);
      cur._ids = [...new Set([...(cur._ids ?? [cur.id]), m.id])];
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
      // name 优先取「和 id 不同的那个」——那才是真显示名
      if (!cur.name || cur.name === cur.id) {
        if (m.name && m.name !== m.id) cur.name = m.name;
      }
      cur.channel = cur.channel ?? m.channel;
    }
  }

  const models = [...byId.values()]
    .map((m) => {
      const ids = [...new Set(m._ids ?? [m.id])];
      // 能调通的 id：优先「不是任何条目显示名」的那个
      const displayNames = new Set(
        [...byId.values()].map((x) => x.name).filter(Boolean)
      );
      const usable = ids.filter((x) => !displayNames.has(x) || ids.length === 1);
      const id = (usable.length ? usable : ids)[0];
      const { _ids, ...rest } = m;
      return { ...rest, id, ids, accounts: [...new Set(m.accounts)] };
    })
    .sort((a, b) => firstInput(a) - firstInput(b) || String(a.id).localeCompare(String(b.id)));

  return { models, accounts: list };
}
