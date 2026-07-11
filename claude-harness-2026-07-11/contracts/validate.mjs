// contracts 전용 JSON Schema 부분집합 검증기 — 의존성 제로.
// 범용 검증기가 아니다. 계약 파일에 새 키워드를 쓰려면 여기에 먼저 구현하고 테스트를 추가한다.
// 지원: type(배열 포함), required, properties, items, enum, const, minLength,
//       minimum, pattern, $ref(#/$defs/* 로컬만), allOf, if/then/else

export function validate(schema, data, root = schema, path = '$') {
  const errors = [];
  const s = resolveRef(schema, root);

  if (s.const !== undefined && data !== s.const) {
    errors.push(`${path}: const ${JSON.stringify(s.const)} 불일치 (실제: ${JSON.stringify(data)})`);
  }
  if (s.enum && !s.enum.includes(data)) {
    errors.push(`${path}: enum ${JSON.stringify(s.enum)}에 없는 값 (실제: ${JSON.stringify(data)})`);
  }
  if (s.type && !checkType(s.type, data)) {
    errors.push(`${path}: type ${JSON.stringify(s.type)} 불일치 (실제: ${typeName(data)})`);
    return errors; // 타입이 틀리면 하위 검사는 무의미
  }
  if (typeof data === 'string') {
    if (s.minLength !== undefined && data.length < s.minLength) {
      errors.push(`${path}: minLength ${s.minLength} 미달`);
    }
    if (s.pattern && !new RegExp(s.pattern).test(data)) {
      errors.push(`${path}: pattern ${s.pattern} 불일치`);
    }
  }
  if (typeof data === 'number' && s.minimum !== undefined && data < s.minimum) {
    errors.push(`${path}: minimum ${s.minimum} 미달 (실제: ${data})`);
  }
  if (isObject(data)) {
    for (const req of s.required ?? []) {
      if (!(req in data)) errors.push(`${path}: 필수 키 "${req}" 없음`);
    }
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (key in data) errors.push(...validate(sub, data[key], root, `${path}.${key}`));
    }
  }
  if (Array.isArray(data) && s.items) {
    data.forEach((item, i) => errors.push(...validate(s.items, item, root, `${path}[${i}]`)));
  }
  for (const sub of s.allOf ?? []) {
    errors.push(...validate(sub, data, root, path));
  }
  if (s.if) {
    const passes = validate(s.if, data, root, path).length === 0;
    if (passes && s.then) errors.push(...validate(s.then, data, root, path));
    if (!passes && s.else) errors.push(...validate(s.else, data, root, path));
  }
  return errors;
}

function resolveRef(schema, root) {
  if (!schema.$ref) return schema;
  const m = schema.$ref.match(/^#\/\$defs\/([^/]+)$/);
  if (!m || !root.$defs?.[m[1]]) throw new Error(`지원하지 않는 $ref: ${schema.$ref}`);
  return root.$defs[m[1]];
}

function checkType(type, data) {
  if (Array.isArray(type)) return type.some((t) => checkType(t, data));
  switch (type) {
    case 'object': return isObject(data);
    case 'array': return Array.isArray(data);
    case 'string': return typeof data === 'string';
    case 'integer': return Number.isInteger(data);
    case 'number': return typeof data === 'number' && Number.isFinite(data);
    case 'boolean': return typeof data === 'boolean';
    case 'null': return data === null;
    default: throw new Error(`지원하지 않는 type: ${type}`);
  }
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
