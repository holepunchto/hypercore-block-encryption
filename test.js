const test = require('brittle')
const b4a = require('b4a')

const BlockEncryption = require('./')

test('basic', async t => {
  const block = new BlockEncryption({
    async get (id) {
      await Promise.resolve()
      return b4a.alloc(32, id)
    }
  })

  t.is(block.padding, 16)
  t.ok(block.seekable)

  const padding = block.padding

  const b0 = b4a.alloc(32, 0)
  const b1 = b4a.alloc(32, 1)
  const b2 = b4a.alloc(32, 2)

  const e0 = b4a.alloc(b0.byteLength + block.padding)
  const e1 = b4a.alloc(b1.byteLength + block.padding)
  const e2 = b4a.alloc(b2.byteLength + block.padding)

  e0.set(b0, padding)
  e1.set(b1, padding)
  e2.set(b2, padding)

  t.exception(() => block.encrypt(0, e0))

  await block.load(0)
  await block.encrypt(0, e0, 0)

  await block.load(1)
  await block.encrypt(1, e1, 1)

  await block.load(2)
  await block.encrypt(2, e2, 2)

  t.is(e0.byteLength, b0.byteLength + padding)
  t.is(e1.byteLength, b1.byteLength + padding)
  t.is(e2.byteLength, b2.byteLength + padding)

  await block.decrypt(0, e0)
  await block.decrypt(1, e1)
  await block.decrypt(2, e2)

  t.alike(e0.subarray(padding), b0)
  t.alike(e1.subarray(padding), b1)
  t.alike(e2.subarray(padding), b2)
})

test('legacy', async t => {
  const block = new BlockEncryption({
    legacy: true,
    block: true,
    encryptionKey: b4a.alloc(32, 1),
    hypercoreKey: b4a.alloc(32, 2)
  })

  const b0 = b4a.alloc(32, 0)
  const b1 = b4a.alloc(32, 1)
  const b2 = b4a.alloc(32, 2)

  const e0 = b4a.alloc(40)
  const e1 = b4a.alloc(40)
  const e2 = b4a.alloc(40)

  e0.set(b0, 8)
  e1.set(b1, 8)
  e2.set(b2, 8)

  t.is(block.padding, 8)
  t.ok(block.seekable)

  block.encrypt(0, e0, 0)
  block.encrypt(1, e1, 1)
  block.encrypt(2, e2, 2)

  t.is(e0.byteLength, b0.byteLength + 8)
  t.is(e1.byteLength, b1.byteLength + 8)
  t.is(e2.byteLength, b2.byteLength + 8)

  block.decrypt(0, e0)
  block.decrypt(1, e1)
  block.decrypt(2, e2)

  t.alike(e0.subarray(8), b0)
  t.alike(e1.subarray(8), b1)
  t.alike(e2.subarray(8), b2)
})
