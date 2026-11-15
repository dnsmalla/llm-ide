// Gate for the glibc 2.28 compat module: reads `objdump -T` output and fails when the module needs a
// symbol version the Ubuntu 20.04 server does not have. The rule itself lives in sqlite-compat.mjs.
// Usage: node desktop/scripts/sqlite-compat-check.mjs [<objdump -T output file>]   (stdin when no file)
import { readFileSync } from 'node:fs';
import { checkCeilings, symbolCeilings } from './sqlite-compat.mjs';

const source = process.argv[2];
const text = source ? readFileSync(source, 'utf8') : readFileSync(0, 'utf8');
const found = symbolCeilings(text);
console.log(`highest symbol versions: GLIBC ${found.glibc}, GLIBCXX ${found.glibcxx}, CXXABI ${found.cxxabi}`);
const problems = checkCeilings(text);
for (const problem of problems) console.error(`::error::${problem}`);
process.exit(problems.length ? 1 : 0);
