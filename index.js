const sodium = require('sodium-universal')
const crypto = require('hypercore-crypto')
const ReadyResource = require('ready-resource')
const c = require('compact-encoding')
const b4a = require('b4a')

const HYPERCORE_CAPS = crypto.namespace('hypercore', 6)
const HYPERCORE_BLOCK_ENCRYPTION = HYPERCORE_CAPS[5]

const [NS_BLINDING_KEY] = crypto.namespace('hypercore-encryption', 1)

const nonce = b4a.alloc(sodium.crypto_stream_NONCEBYTES)

class LegacyProvider {
  constructor ({ encryptionKey, hypercoreKey, block = false, compat = true } = {}) {
    const subKeys = b4a.alloc(2 * sodium.crypto_stream_KEYBYTES)

    this.key = encryptionKey
    this.blockKey = block ? encryptionKey : subKeys.subarray(0, sodium.crypto_stream_KEYBYTES)
    this.blindingKey = subKeys.subarray(sodium.crypto_stream_KEYBYTES)

    this.isBlock = !!block
    this.padding = 8

    this.compat = compat

    if (!block) {
      if (compat) sodium.crypto_generichash_batch(this.blockKey, [encryptionKey], hypercoreKey)
      else sodium.crypto_generichash_batch(this.blockKey, [HYPERCORE_BLOCK_ENCRYPTION, hypercoreKey, encryptionKey])
    }

    sodium.crypto_generichash(this.blindingKey, this.blockKey)
  }

  encrypt (index, block, fork) {
    const padding = block.subarray(0, this.padding)
    block = block.subarray(this.padding)

    c.uint64.encode({ start: 0, end: 8, buffer: padding }, fork)
    c.uint64.encode({ start: 0, end: 8, buffer: nonce }, index)

    // Zero out any previous padding.
    nonce.fill(0, 8, 8 + padding.byteLength)

    // Blind the fork ID, possibly risking reusing the nonce on a reorg of the
    // Hypercore. This is fine as the blinding is best-effort and the latest
    // fork ID shared on replication anyway.
    sodium.crypto_stream_xor(
      padding,
      padding,
      nonce,
      this.blindingKey
    )

    nonce.set(padding, 8)

    // The combination of a (blinded) fork ID and a block index is unique for a
    // given Hypercore and is therefore a valid nonce for encrypting the block.
    sodium.crypto_stream_xor(
      block,
      block,
      nonce,
      this.blockKey
    )
  }

  decrypt (index, block) {
    const padding = block.subarray(0, this.padding)
    block = block.subarray(this.padding)

    c.uint64.encode({ start: 0, end: 8, buffer: nonce }, index)

    nonce.set(padding, 8)

    // Decrypt the block using the blinded fork ID.
    sodium.crypto_stream_xor(
      block,
      block,
      nonce,
      this.blockKey
    )
  }
}

class EncryptionProvider {
  constructor (id, key, host) {
    this.padding = 16
    this.isBlock = true

    this.id = id
    this.key = key
    this.host = host

    this.blindingKey = key ? deriveBlindingKey(id, key) : null
  }

  async decrypt (index, block) {
    if (this.padding !== 16) throw new Error('Unsupported padding')

    const padding = block.subarray(0, this.padding)
    block = block.subarray(this.padding)

    const id = c.uint32.decode({ start: 4, end: 8, buffer: padding })

    const key = await this.host._get(id)
    if (!key) throw new Error('Decryption failed: unknown key')

    c.uint64.encode({ start: 0, end: 8, buffer: nonce }, index)

    nonce.set(padding, 8)

    return sodium.crypto_stream_xor(
      block,
      block,
      nonce,
      key
    )
  }

  encrypt (index, block, fork) {
    if (this.key === null) throw new Error('No encryption has been loaded')
    if (this.padding !== 16) throw new Error('Unsupported padding')

    const padding = block.subarray(0, this.padding)
    block = block.subarray(this.padding)

    sodium.crypto_generichash(padding, block, this.blindingKey)

    // encode padding
    c.uint32.encode({ start: 0, end: 4, buffer: padding }, this.id)
    c.uint32.encode({ start: 4, end: 8, buffer: padding }, fork)

    c.uint64.encode({ start: 0, end: 8, buffer: nonce }, index)

    // Zero out any previous padding.
    nonce.fill(0, 8, 8 + padding.byteLength)

    nonce.set(padding, 8)

    // The combination of a (blinded) fork ID and a block index is unique for a
    // given Hypercore and is therefore a valid nonce for encrypting the block.
    sodium.crypto_stream_xor(
      block,
      block,
      nonce,
      this.key
    )
  }
}

class HypercoreEncryption extends ReadyResource {
  constructor (opts = {}) {
    super()

    this._get = opts.get
    this.compat = false

    this._initialId = opts.id !== undefined ? opts.id : null

    this.provider = opts.legacy === true
      ? new LegacyProvider(opts)
      : new EncryptionProvider(this._initialId, null, this)
  }

  get legacy () {
    return this.provider instanceof LegacyProvider
  }

  get padding () {
    return this.provider.padding
  }

  get seekable () {
    return this.padding !== 0
  }

  _open () {
    if (this.provider && this.provider instanceof LegacyProvider) return
    if (this._initialId !== null) return this.load(this._initialId)
  }

  async load (id) {
    const key = await this._get(id)
    if (!key) throw new Error('Unrecognised encryption id')

    this.provider = new EncryptionProvider(id, key, this)
  }

  async decrypt (index, block) {
    if (!this.opened) await this.ready()
    return this.provider.decrypt(index, block)
  }

  async encrypt (index, block, fork) {
    if (!this.opened) await this.ready()
    return this.provider.encrypt(index, block, fork)
  }
}

module.exports = HypercoreEncryption

function deriveBlindingKey (id, encryptionKey) {
  const idBuffer = c.encode(c.uint, id)
  const key = b4a.alloc(sodium.crypto_generichash_KEYBYTES)
  sodium.crypto_generichash_batch(key, [NS_BLINDING_KEY, idBuffer], encryptionKey)

  return key
}
