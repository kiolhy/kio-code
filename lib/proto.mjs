// OTLP protobuf 轻量解析：不做 schema，只按 wire format 走一遍，
// 把 length-delimited 字段里"看起来像 UTF-8 文本"的内容提出来。
// 目的：让管理面板能直接看懂 CLI 上报的 span 名 / 属性 / 日志正文。

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_32BIT = 5;

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let bytes = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    bytes++;
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) return { value: result, pos, bytes };
    shift += 7;
    if (shift > 63) break;
  }
  return null;
}

const PRINTABLE = /^[\x20-\x7e\r\n\t\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]{2,}$/;

function looksLikeText(buf) {
  if (buf.length < 2 || buf.length > 8192) return false;
  let printable = 0;
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13) printable++;
    else if (b >= 0x20 && b <= 0x7e) printable++;
    else if (b >= 0x80) printable += 0.5; // 多字节 UTF-8
  }
  return printable / buf.length > 0.85;
}

/**
 * 扫描一层消息。返回 { fields: [{no, wire, value|text|len|nested}], texts: [] }
 */
export function scanMessage(buf, depth = 0) {
  const fields = [];
  const texts = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.pos;
    const fieldNo = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (fieldNo === 0) break;

    if (wire === WIRE_VARINT) {
      const v = readVarint(buf, pos);
      if (!v) break;
      pos = v.pos;
      fields.push({ no: fieldNo, wire, value: v.value });
    } else if (wire === WIRE_64BIT) {
      if (pos + 8 > buf.length) break;
      fields.push({ no: fieldNo, wire, value: buf.readBigUInt64LE(pos).toString() });
      pos += 8;
    } else if (wire === WIRE_LEN) {
      const len = readVarint(buf, pos);
      if (!len) break;
      pos = len.pos;
      const end = pos + len.value;
      if (end > buf.length) break;
      const slice = buf.subarray(pos, end);
      pos = end;
      if (looksLikeText(slice)) {
        const text = slice.toString('utf8');
        if (PRINTABLE.test(text)) {
          fields.push({ no: fieldNo, wire, text });
          texts.push(text);
          continue;
        }
      }
      if (depth < 3) {
        const nested = scanMessage(slice, depth + 1);
        if (nested.fields.length > 0) {
          fields.push({ no: fieldNo, wire, nested: nested.fields });
          texts.push(...nested.texts);
          continue;
        }
      }
      fields.push({ no: fieldNo, wire, len: slice.length, hex: slice.subarray(0, 32).toString('hex') });
    } else if (wire === WIRE_32BIT) {
      if (pos + 4 > buf.length) break;
      fields.push({ no: fieldNo, wire, value: buf.readUInt32LE(pos) });
      pos += 4;
    } else {
      break; // 未知 wire type，停止
    }
  }
  return { fields, texts };
}

/** 尽力提取 OTLP 关键信息 */
export function summarizeOtlp(buf, kind) {
  const { texts } = scanMessage(buf);
  const uniq = [...new Set(texts)];
  const summary = {
    kind,
    bytes: buf.length,
    texts: uniq.slice(0, 400),
  };
  if (kind === 'logs') {
    summary.looksLike = uniq.filter((t) => /log|severity|body|trace|span/i.test(t)).slice(0, 20);
  } else {
    summary.looksLike = uniq.filter((t) => /span|trace|service|gen_ai|http|model/i.test(t)).slice(0, 40);
  }
  return summary;
}

/** 把 JSON 形式的 OTLP 压平成一行摘要 */
export function summarizeOtlpJson(obj, kind) {
  const out = { kind, format: 'json', resources: 0, scopes: 0, items: [] };
  const groups = obj?.resourceLogs ?? obj?.resourceSpans ?? [];
  out.resources = groups.length;
  for (const g of groups) {
    const attrs = {};
    for (const a of g.resource?.attributes ?? []) attrs[a.key] = a.value?.stringValue ?? a.value?.intValue ?? a.value?.boolValue;
    const scopes = g.scopeLogs ?? g.scopeSpans ?? [];
    out.scopes += scopes.length;
    for (const s of scopes) {
      const records = s.logRecords ?? s.spans ?? [];
      for (const r of records) {
        out.items.push({
          resource: attrs,
          name: r.name ?? r.body?.stringValue ?? '',
          severity: r.severityText,
          timeUnixNano: r.timeUnixNano ?? r.startTimeUnixNano,
          attributes: Object.fromEntries(
            (r.attributes ?? []).map((a) => [
              a.key,
              a.value?.stringValue ?? a.value?.intValue ?? a.value?.boolValue ?? a.value?.doubleValue,
            ])
          ),
          body: r.body?.stringValue ?? r.body?.kvlistValue ?? undefined,
          traceId: r.traceId,
          spanId: r.spanId,
        });
      }
    }
  }
  return out;
}
