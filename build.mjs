import { readFileSync, writeFileSync } from 'node:fs';
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const write = (name, content) => writeFileSync(new URL(name, import.meta.url), content);
const layout = read('layout.part')
  .replace("img-src data:; base-uri", "img-src data:; frame-src blob:; connect-src 'self'; base-uri")
  .replace('<title>PacoSAT</title>', '<title>PacoSAT</title><!--FARO_TOKEN-->');
const css = ['style.part','design.part','polish.part'].map(read).join('\n');
const script = ['data.part','ui.part','pdf-cloud-ui.part','operations.part','workflows.part','sat-ui.part','monitor-ui.part'].map(read).join('\n');
write('Faro-Fiscal.html', layout.replace('/*STYLES*/', () => css).replace('/*SCRIPT*/', () => script));
write('xml-core.mjs', read('data.part') + '\nexport { crc32, parseXml, zipXml };\n');
