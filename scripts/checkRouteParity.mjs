import fs from 'fs';

const getRoutes = (f) => {
  const content = fs.readFileSync(f, 'utf8');
  const matches = [...content.matchAll(/app\.(get|post|put|delete|patch|all)\(\s*["'`]([^\s"'`]+)/g)];
  return matches.map(m => `${m[1].toUpperCase()} ${m[2]}`).sort();
};

const dev = getRoutes('server.ts');
const prod = getRoutes('api/index.ts');

console.log('dev count:', dev.length, 'prod count:', prod.length);

const devOnly = dev.filter(r => !prod.includes(r) && !r.includes('*'));
const prodOnly = prod.filter(r => !dev.includes(r));

console.log('dev only:', devOnly);
console.log('prod only:', prodOnly);

if (devOnly.length === 0 && prodOnly.length === 0) {
  console.log('SUCCESS: PERFECT ROUTE PARITY MAINTAINED!');
  process.exit(0);
} else {
  console.error('FAILURE: Route mismatch between server.ts and api/index.ts');
  process.exit(1);
}
