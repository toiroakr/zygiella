// Reads `--name value` pairs. A flag that is unknown, has no value or is followed by another flag throws, so a typo
// cannot fall back to the default of a run that takes minutes. A bare `--` (what `pnpm bench -- --out x` forwards) is skipped.
export function parseFlags(argv, known) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    if (!known.includes(arg.slice(2)))
      throw new Error(`unknown flag ${arg}; known: ${known.map((name) => `--${name}`).join(", ")}`);
    if (Object.hasOwn(flags, arg.slice(2))) throw new Error(`${arg} is given twice`);
    const value = argv[i + 1];
    if (value === undefined || value === "" || value.startsWith("--"))
      throw new Error(`${arg} needs a value`);
    flags[arg.slice(2)] = value;
    i++;
  }
  return flags;
}

// a comma separated list whose items must all be in `known`; undefined when the flag is absent
export function parseList(value, known, flag) {
  if (value === undefined) return undefined;
  const items = value.split(",");
  for (const item of items)
    if (!known.includes(item))
      throw new Error(`${flag}: unknown name "${item}"; known: ${known.join(", ")}`);
  return items;
}
