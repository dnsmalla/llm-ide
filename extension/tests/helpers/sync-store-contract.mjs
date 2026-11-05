// The SyncStore contract (design 2.1). Every adapter's test file calls this with its own factory.
export function runSyncStoreContract(test, assert, makeStore, label) {
  test(`${label}: put/get round trip, absent file is null, replace is whole`, async () => {
    const s = await makeStore();
    assert.equal(await s.get('a/b/c.bin'), null);
    await s.put('a/b/c.bin', Buffer.from('one'));
    assert.equal(Buffer.from(await s.get('a/b/c.bin')).toString(), 'one');
    await s.put('a/b/c.bin', Buffer.from('second'));
    assert.equal(Buffer.from(await s.get('a/b/c.bin')).toString(), 'second');
  });
  test(`${label}: list is flat and sized; absent dir lists empty`, async () => {
    const s = await makeStore();
    await s.put('x/in/1.bin', Buffer.alloc(3));
    await s.put('x/in/2.bin', Buffer.alloc(5));
    await s.put('x/in/sub/3.bin', Buffer.alloc(1));
    const names = (await s.list('x/in')).filter((e) => e.name.endsWith('.bin')).map((e) => `${e.name}:${e.size}`).sort();
    assert.deepEqual(names, ['1.bin:3', '2.bin:5']);
    assert.deepEqual(await s.list('nope'), []);
  });
  test(`${label}: remove is idempotent; removeTree deletes everything below`, async () => {
    const s = await makeStore();
    await s.put('t/d/k.bin', Buffer.from('k'));
    await s.put('t/d/s/1.bin', Buffer.from('1'));
    await s.remove('t/d/k.bin');
    await s.remove('t/d/k.bin');
    assert.equal(await s.get('t/d/k.bin'), null);
    await s.removeTree('t/d');
    assert.equal(await s.get('t/d/s/1.bin'), null);
    assert.deepEqual(await s.list('t/d/s'), []);
  });
  test(`${label}: bad paths are refused before any I/O`, async () => {
    const s = await makeStore();
    for (const p of ['', '/a', 'a/../b', 'a/./b', 'a//b', 'a/b c', 'x'.repeat(65), '1/2/3/4/5/6/7']) {
      await assert.rejects(() => s.put(p, Buffer.from('x')), (e) => e.code === 'SYNC_BAD_PATH', p);
    }
    await assert.rejects(() => s.put('big.bin', Buffer.alloc(1052673)), (e) => e.code === 'SYNC_TOO_LARGE');
  });
}
