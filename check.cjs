const fs = require('fs');
const parser = require('@babel/parser');

const code = fs.readFileSync('src/App.jsx', 'utf8');

try {
  const ast = parser.parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'dynamicImport', 'topLevelAwait'],
    errorRecovery: true,
  });
  if (ast.errors && ast.errors.length) {
    console.log(`RECOVERED ${ast.errors.length} ERRORS:`);
    for (const e of ast.errors) {
      console.log(`- line ${e.loc && e.loc.line}, col ${e.loc && e.loc.column}: ${e.reasonCode || ''} ${e.message}`);
    }
  } else {
    console.log('PARSED OK (no errors)');
  }
} catch (e) {
  console.log('FATAL PARSE ERROR:');
  console.log(e.message);
  console.log(JSON.stringify(e.loc));
}
