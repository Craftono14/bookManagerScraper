const { performSearchAll } = require('./index');

(async () => {
  try {
    const rows = await performSearchAll('seven seas', 'keyword');
    console.log('Found', rows.length, 'results');
    for (let i=0;i<Math.min(rows.length,10);i++) console.log(rows[i]);
  } catch (e) {
    console.error('Test failed:', e);
  }
})();
