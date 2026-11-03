import { crc32, deflateRawSync } from 'node:zlib'

// A zip writer for the organisation export (R-299): deflate, no ZIP64, no
// streaming. Hand-rolled rather than a dependency, because node:zlib already
// does the compression and the checksum, and what is left is three fixed
// headers.
//
// ponytail: whole archive in memory and a 4 GB / 65,535-entry ceiling (no
// ZIP64). PRD 10 §8 sizes an org at tens of MB; a portfolio whose documents
// approach either limit needs ZIP64 and a streamed upload.

export interface ZipEntry {
  name: string
  data: Buffer
}

export function zip(entries: readonly ZipEntry[], now = new Date()): Buffer {
  // MS-DOS time and date, which is what every zip reader shows.
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()

  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const body = deflateRawSync(entry.data)
    const fields = Buffer.alloc(26)
    fields.writeUInt16LE(20, 0) // version needed
    fields.writeUInt16LE(0x0800, 2) // UTF-8 names
    fields.writeUInt16LE(8, 4) // deflate
    fields.writeUInt16LE(time, 6)
    fields.writeUInt16LE(date, 8)
    fields.writeUInt32LE(crc32(entry.data), 10)
    fields.writeUInt32LE(body.length, 14)
    fields.writeUInt32LE(entry.data.length, 18)
    fields.writeUInt16LE(name.length, 22)
    fields.writeUInt16LE(0, 24) // extra length

    const local = Buffer.concat([u32(0x04034b50), fields, name, body])
    // Comment length, disk number, internal (2 each) and external (4)
    // attributes, all zero.
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), fields, Buffer.alloc(10), u32(offset), name]))
    locals.push(local)
    offset += local.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(directory.length),
    u32(offset),
    u16(0),
  ])
  return Buffer.concat([...locals, directory, end])
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}
