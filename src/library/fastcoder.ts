// Decoder for FastCoder v3 ("FAST" magic) archives, the format djay uses for every
// record in its YapDatabase media library. Objects archived through NSCoding come
// back as plain objects with a `$class` field.
//
// Layout: header { u32 'FAST', u16 major=3, u16 minor, u32 objectCount, u32 classCount,
// u32 stringCount } then one root value. Numbers are aligned to their own size,
// strings are NUL-terminated UTF-8 and are remembered for later aliases.

const T = {
  Nil: 0, Null: 1, ObjectAlias8: 2, ObjectAlias16: 3, ObjectAlias32: 4,
  StringAlias8: 5, StringAlias16: 6, StringAlias32: 7, String: 8,
  Dictionary: 9, Array: 10, Set: 11, OrderedSet: 12, True: 13, False: 14,
  Int8: 15, Int16: 16, Int32: 17, Int64: 18, Float32: 19, Float64: 20,
  Data: 21, Date: 22, MutableString: 23, MutableDictionary: 24, MutableArray: 25,
  MutableSet: 26, MutableOrderedSet: 27, MutableData: 28, ClassDefinition: 29,
  Object8: 30, Object16: 31, Object32: 32, URL: 33, Point: 34, Size: 35, Rect: 36,
  Range: 37, Vector: 38, AffineTransform: 39, Transform3D: 40, MutableIndexSet: 41,
  IndexSet: 42, NSCodedObject: 43, DecimalNumber: 44, One: 45, Zero: 46, End: 47,
  // Newer minor versions: date as seconds since 2001-01-01 (NSDate reference date).
  ReferenceDate: 48,
} as const;

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

const END = Symbol("end");

export interface Decoded {
  root: any;
  objectCount: number;
  stringCount: number;
  objectsSeen: number;
  stringsSeen: number;
}

export function isFastCoder(buf: Uint8Array): boolean {
  return buf.length >= 20 && buf[0] === 0x54 && buf[1] === 0x53 && buf[2] === 0x41 && buf[3] === 0x46;
}

export function decodeFastCoder(input: Uint8Array): Decoded {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!isFastCoder(buf)) throw new Error("not a FastCoder archive");
  const major = buf.readUInt16LE(4);
  if (major !== 3) throw new Error(`unsupported FastCoder major version ${major}`);
  const objectCount = buf.readUInt32LE(8);
  const stringCount = buf.readUInt32LE(16);
  let o = 20;
  const strings: string[] = [];
  const objects: any[] = [];
  const classes: { name: string; keys: string[] }[] = [];

  const align = (n: number) => {
    const r = o % n;
    if (r) o += n - r;
  };
  const u8 = () => buf[o++];
  const u16 = () => { align(2); const v = buf.readUInt16LE(o); o += 2; return v; };
  const u32 = () => { align(4); const v = buf.readUInt32LE(o); o += 4; return v; };
  const rawString = () => {
    const end = buf.indexOf(0, o);
    if (end < 0) throw new Error("unterminated string");
    const s = buf.toString("utf8", o, end);
    o = end + 1;
    return s;
  };
  const cache = (v: any) => {
    objects.push(v);
    return v;
  };

  const read = (): any => {
    if (o >= buf.length) throw new Error("unexpected end of archive");
    const type = u8();
    switch (type) {
      case T.Nil: return END;
      case T.Null: return null;
      case T.End: return END;
      case T.ObjectAlias8: return objects[u8()];
      case T.ObjectAlias16: return objects[u16()];
      case T.ObjectAlias32: return objects[u32()];
      case T.StringAlias8: return strings[u8()];
      case T.StringAlias16: return strings[u16()];
      case T.StringAlias32: return strings[u32()];
      case T.String: { const s = rawString(); strings.push(s); return s; }
      case T.MutableString: { const s = rawString(); return cache(s); }
      case T.True: return true;
      case T.False: return false;
      case T.One: return 1;
      case T.Zero: return 0;
      case T.Int8: return buf.readInt8(o++);
      case T.Int16: { align(2); const v = buf.readInt16LE(o); o += 2; return v; }
      case T.Int32: { align(4); const v = buf.readInt32LE(o); o += 4; return v; }
      case T.Int64: { align(8); const v = buf.readBigInt64LE(o); o += 8; return Number(v); }
      case T.Float32: { align(4); const v = buf.readFloatLE(o); o += 4; return Math.round(v * 1e5) / 1e5; }
      case T.Float64: { align(8); const v = buf.readDoubleLE(o); o += 8; return v; }
      case T.DecimalNumber: { align(8); const v = buf.readDoubleLE(o); o += 8; return v; }
      case T.Date: {
        align(8);
        const v = buf.readDoubleLE(o);
        o += 8;
        return cache({ $date: new Date(v * 1000).toISOString() });
      }
      case T.ReferenceDate: {
        align(8);
        const v = buf.readDoubleLE(o);
        o += 8;
        return cache({ $date: new Date(APPLE_EPOCH_MS + v * 1000).toISOString() });
      }
      case T.Data:
      case T.MutableData: {
        const len = u32();
        const bytes = buf.subarray(o, o + len);
        o += len;
        align(4);
        return cache({ $data: bytes.length, preview: bytes.subarray(0, 16).toString("hex") });
      }
      case T.Dictionary:
      case T.MutableDictionary: {
        const n = u32();
        const d: Record<string, any> = {};
        if (type === T.MutableDictionary) cache(d);
        for (let i = 0; i < n; i++) {
          const v = read();
          const k = read();
          d[String(k)] = v;
        }
        return type === T.Dictionary ? cache(d) : d;
      }
      case T.Array:
      case T.MutableArray:
      case T.Set:
      case T.MutableSet:
      case T.OrderedSet:
      case T.MutableOrderedSet: {
        const n = u32();
        const a: any[] = [];
        const mutable = type === T.MutableArray || type === T.MutableSet || type === T.MutableOrderedSet;
        if (mutable) cache(a);
        for (let i = 0; i < n; i++) a.push(read());
        return mutable ? a : cache(a);
      }
      case T.URL: {
        const s = read();
        const base = read();
        // URLs are not entered in the object table (the header counts confirm this).
        return base !== END && base ? `${base}${s}` : s;
      }
      case T.Point: { align(8); const v = [buf.readDoubleLE(o), buf.readDoubleLE(o + 8)]; o += 16; return v; }
      case T.Size: { align(8); const v = [buf.readDoubleLE(o), buf.readDoubleLE(o + 8)]; o += 16; return v; }
      case T.Range: { const loc = u32(); const len = u32(); return { location: loc, length: len }; }
      case T.Rect: { align(8); const v = [0, 1, 2, 3].map((i) => buf.readDoubleLE(o + i * 8)); o += 32; return v; }
      case T.Vector: { align(8); const v = [0, 1, 2, 3].map((i) => buf.readDoubleLE(o + i * 8)); o += 32; return v; }
      case T.AffineTransform: { align(8); const v = [0, 1, 2, 3, 4, 5].map((i) => buf.readDoubleLE(o + i * 8)); o += 48; return v; }
      case T.Transform3D: { align(8); const v = Array.from({ length: 16 }, (_, i) => buf.readDoubleLE(o + i * 8)); o += 128; return v; }
      case T.IndexSet:
      case T.MutableIndexSet: {
        const n = u32();
        const ranges: { location: number; length: number }[] = [];
        for (let i = 0; i < n; i++) ranges.push({ location: u32(), length: u32() });
        return cache({ $indexSet: ranges });
      }
      case T.NSCodedObject: {
        const className = read();
        const obj: Record<string, any> = { $class: className };
        for (;;) {
          const v = read();
          if (v === END) break;
          const k = read();
          obj[String(k)] = v;
        }
        return cache(obj);
      }
      case T.ClassDefinition: {
        const name = read();
        const n = u32();
        const keys: string[] = [];
        for (let i = 0; i < n; i++) keys.push(String(read()));
        classes.push({ name: String(name), keys });
        return read();
      }
      case T.Object8:
      case T.Object16:
      case T.Object32: {
        const idx = type === T.Object8 ? u8() : type === T.Object16 ? u16() : u32();
        const def = classes[idx];
        if (!def) throw new Error(`unknown class index ${idx}`);
        const obj: Record<string, any> = { $class: def.name };
        cache(obj);
        for (const k of def.keys) obj[k] = read();
        return obj;
      }
      default:
        throw new Error(`unknown FastCoder type ${type} at offset ${o - 1}`);
    }
  };

  const root = read();
  return { root: root === END ? null : root, objectCount, stringCount, objectsSeen: objects.length, stringsSeen: strings.length };
}
