// 跨账号模型目录：把各账号探测到的 info 合成一张「模型 + 价格」表
//
// 同一模型可能被多个账号报告，价格取最大值（保守：按最贵的算），
// 标记位（免费/排队/推理）取并集，额度取第一个非空。

function parseInfo(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

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
      balanceTotal: info?.balanceTotal ?? null,
      checkedAt: info?.checkedAt ?? null,
      errors: info?.errors?.length ?? 0,
    });

    for (const m of info?.models ?? []) {
      if (!m?.id) continue;
      const cur = byId.get(m.id);
      if (!cur) {
        byId.set(m.id, { ...m, accounts: [label] });
        continue;
      }
      if (!cur.accounts.includes(label)) cur.accounts.push(label);
      if ((m.credit ?? -1) > (cur.credit ?? -1)) cur.credit = m.credit;
      cur.free = !!(cur.free || m.free);
      cur.queued = !!(cur.queued || m.queued);
      cur.reasoning = !!(cur.reasoning || m.reasoning);
      cur.limit = cur.limit ?? m.limit;
      cur.endpoint = cur.endpoint ?? m.endpoint;
      cur.vendor = cur.vendor ?? m.vendor;
    }
  }

  const models = [...byId.values()]
    .map((m) => ({ ...m, accounts: [...new Set(m.accounts)] }))
    .sort((a, b) => (b.credit ?? -1) - (a.credit ?? -1) || String(a.id).localeCompare(String(b.id)));

  return { models, accounts: list };
}
