/**
 * Minimal ISO 9660 Level 1 generator (single directory, no Rock Ridge/Joliet).
 * - Logical block size: 2048
 * - Primary Volume Descriptor only
 * - Files written in root directory
 * - Uppercase 8.3 names with ;1 version
 * @param {Array<{originalName:string, content:Uint8Array, size:number, lastModified?:Date}>} files
 * @param {string} volumeId up to 32 chars, uppercase A-Z 0-9 _
 * @returns {Uint8Array}
 */
export function createISO9660Image(files, volumeId) {
    const SECTOR = 2048;

    // Normalize and map file metadata
    const normFiles = files.map((f) => {
        const parts = f.originalName.split('.');
        const ext = parts.length > 1 ? parts.pop().toUpperCase() : '';
        const name = parts.join('.').toUpperCase();
        const nm = name.replace(/[^A-Z0-9_]/g, '').substring(0, 8) || 'FILE';
        const ex = ext.replace(/[^A-Z0-9_]/g, '').substring(0, 3);
        const isoName = ex ? `${nm}.${ex};1` : `${nm};1`;
        return {
            isoName,
            data: f.content || new Uint8Array(0),
            size: f.size >>> 0,
            date: f.lastModified || new Date()
        };
    });

    // Helper to align a length to sectors
    const padTo = (len, size) => (len % size) ? (len + (size - (len % size))) : len;

    // We will layout as follows:
    // - System Area: 16 sectors (zeros)
    // - Primary Volume Descriptor (PVD) at sector 16
    // - Supplementary Volume Descriptor (Joliet) at sector 17
    // - Volume Descriptor Set Terminator at sector 18
    // - Path Table (little-endian) at sector 19 (for primary)
    // - Root Directory data (primary) at next LBAs
    // - Joliet Root Directory data at following LBAs (Unicode directory records)
    // - File data extents (each file aligned to 2KB)

    // Compute root directory records (two special + files)
    const rootRecords = [];
    // . and ..
    rootRecords.push(makeDirectoryRecord(/*extentLBA*/0, /*size*/SECTOR, /*flags*/2, '\u0000', new Date()));
    rootRecords.push(makeDirectoryRecord(/*extentLBA*/0, /*size*/SECTOR, /*flags*/2, '\u0001', new Date()));
    for (const f of normFiles) {
        rootRecords.push(makeDirectoryRecord(/*extentLBA*/0, f.size, /*flags*/0, f.isoName, f.date));
    }
    const rootDirSize = computeDirSize(rootRecords);
    const rootDirSectors = Math.ceil(rootDirSize / SECTOR);

    // Layout LBAs
    const PVD_LBA = 16;
    const SVD_JOLIET_LBA = 17; // Joliet supplementary volume descriptor
    const VDST_LBA = 18;
    const PATH_TABLE_LBA = 19;
    const ROOT_DIR_LBA = PATH_TABLE_LBA + 1; // primary root directory LBA
    // we'll place Joliet root directory immediately after primary root directory
    const JOLIET_ROOT_DIR_LBA = ROOT_DIR_LBA + rootDirSectors;
    let nextLBA = JOLIET_ROOT_DIR_LBA + rootDirSectors; // after primary + joliet root

    // Assign file extents
    const fileExtents = [];
    for (const f of normFiles) {
        const lba = nextLBA;
        fileExtents.push({ lba, size: f.size });
        nextLBA += Math.ceil(f.size / SECTOR);
    }

    // Fill actual directory records with proper LBAs and sizes for primary (ASCII/8.3)
    const rootRecordsFilled = [];
    // . and ..
    rootRecordsFilled.push(makeDirectoryRecord(ROOT_DIR_LBA, rootDirSectors * SECTOR, 2, '\u0000', new Date()));
    rootRecordsFilled.push(makeDirectoryRecord(ROOT_DIR_LBA, rootDirSectors * SECTOR, 2, '\u0001', new Date()));
    for (let i = 0; i < normFiles.length; i++) {
        const f = normFiles[i];
        const ex = fileExtents[i];
        rootRecordsFilled.push(makeDirectoryRecord(ex.lba, ex.size, 0, f.isoName, f.date));
    }

    // Build Joliet root directory records (Unicode UCS-2BE names)
    const jolietRecordsFilled = [];
    jolietRecordsFilled.push(makeDirectoryRecordJoliet(JOLIET_ROOT_DIR_LBA, rootDirSectors * SECTOR, 2, '\u0000', new Date()));
    jolietRecordsFilled.push(makeDirectoryRecordJoliet(JOLIET_ROOT_DIR_LBA, rootDirSectors * SECTOR, 2, '\u0001', new Date()));
    for (let i = 0; i < normFiles.length; i++) {
        const f = normFiles[i];
        const ex = fileExtents[i];
        // convert isoName (ASCII) to a Joliet-compatible Unicode filename:
        // strip version ;1 for storing in Joliet and encode as UCS-2BE
        const jname = f.isoName.replace(/;1$/i, '');
        jolietRecordsFilled.push(makeDirectoryRecordJoliet(ex.lba, ex.size, 0, jname, f.date));
    }

    // Total image size in sectors
    const totalSectors = Math.max(nextLBA, ROOT_DIR_LBA + rootDirSectors);
    const image = new Uint8Array(totalSectors * SECTOR);
    const dv = new DataView(image.buffer);

    // System area is zero-initialized by default

    // Primary Volume Descriptor (PVD)
    {
        const off = PVD_LBA * SECTOR;
        dv.setUint8(off + 0, 1); // Type Code = 1
        writeA(image, off + 1, 'CD001', 5);
        dv.setUint8(off + 6, 1); // Version
        writeA(image, off + 8, '', 32); // System Identifier (blank)
        writeA(image, off + 40, volumeId.padEnd(32, ' ').slice(0, 32), 32); // Volume Identifier

        // Unused 8 bytes (48..55)
        // Volume Space Size (LE and BE)
        dv.setUint32(off + 80, totalSectors, true);
        dv.setUint32(off + 84, totalSectors, false);

        // Volume Set Size, Volume Sequence Number
        dv.setUint16(off + 120, 1, true); dv.setUint16(off + 122, 1, false);
        dv.setUint16(off + 124, 1, true); dv.setUint16(off + 126, 1, false);

        // Logical Block Size
        dv.setUint16(off + 128, SECTOR, true); dv.setUint16(off + 130, SECTOR, false);

        // Path Table Size (we have only root, so very small; still put 10.. bytes)
        const pathTableSize = 10; // one root record
        dv.setUint32(off + 132, pathTableSize, true);
        dv.setUint32(off + 136, pathTableSize, false);

        // Type L Path Table Location (LE)
        dv.setUint32(off + 140, PATH_TABLE_LBA, true);
        // Optional L Path Table (2nd copy) not set
        // Type M Path Table (BE)
        dv.setUint32(off + 148, 0, false);

        // Root Directory Record (34 bytes min, but variable)
        const rootRec = makeDirectoryRecord(ROOT_DIR_LBA, rootDirSectors * SECTOR, 2, '\u0000', new Date());
        image.set(rootRec, off + 156);

        // Volume set identifiers (we keep blank)
        writeA(image, off + 190, '', 128); // Publisher
        writeA(image, off + 318, '', 128); // Data Preparer
        writeA(image, off + 446, 'CDROM', 128); // Application Identifier (optional)

        // Dates (we put zeros or current date)
        const nowStr = isoDateString(new Date());
        writeA(image, off + 813, nowStr, 17); // Volume Creation Date
        writeA(image, off + 830, nowStr, 17); // Modification
        writeA(image, off + 847, '0000000000000000', 17); // Expiration
        writeA(image, off + 864, '0000000000000000', 17); // Effective

        // File structure version
        dv.setUint8(off + 881, 1);
    }

    // Supplementary Volume Descriptor (Joliet) - provides Unicode (UCS-2BE) filenames for clients that support Joliet
    {
        const off = SVD_JOLIET_LBA * SECTOR;
        dv.setUint8(off + 0, 2); // Type Code = 2 (Supplementary)
        writeA(image, off + 1, 'CD001', 5);
        dv.setUint8(off + 6, 1); // Version

        // System Identifier left blank
        writeA(image, off + 8, '', 32);
        // Volume Identifier in UCS-2 is stored by Joliet clients; store ASCII here and let directory records contain UCS-2 names
        writeA(image, off + 40, volumeId.padEnd(32, ' ').slice(0, 32), 32);

        // Volume Space Size (LE/BE)
        dv.setUint32(off + 80, totalSectors, true);
        dv.setUint32(off + 84, totalSectors, false);

        // Vol set size/sequence/logical block size as PVD
        dv.setUint16(off + 120, 1, true); dv.setUint16(off + 122, 1, false);
        dv.setUint16(off + 124, 1, true); dv.setUint16(off + 126, 1, false);
        dv.setUint16(off + 128, SECTOR, true); dv.setUint16(off + 130, SECTOR, false);

        // Path table size omitted (Joliet usually ignores primary path tables)
        dv.setUint32(off + 132, 0, true);
        dv.setUint32(off + 136, 0, false);
        dv.setUint32(off + 140, 0, true);
        dv.setUint32(off + 148, 0, false);

        // Root Directory Record for Joliet - points to separate Joliet root area
        const rootRecJ = makeDirectoryRecordJoliet(JOLIET_ROOT_DIR_LBA, rootDirSectors * SECTOR, 2, '\u0000', new Date());
        image.set(rootRecJ, off + 156);

        // Set Joliet escape sequence "%/E" at offset 88 (per Joliet spec) to denote UCS-2
        writeA(image, off + 88, '%/E', 32);

        // Application ID etc
        writeA(image, off + 446, 'JOLIET   ', 128);

        // Version
        dv.setUint8(off + 881, 1);
    }

    // Volume Descriptor Set Terminator
    {
        const off = VDST_LBA * SECTOR;
        dv.setUint8(off + 0, 255);
        writeA(image, off + 1, 'CD001', 5);
        dv.setUint8(off + 6, 1);
    }

    // Path Table (LE) - only root (for primary descriptor)
    {
        const off = PATH_TABLE_LBA * SECTOR;
        // Root directory: name length = 1, name = 0x00
        dv.setUint8(off + 0, 1); // name length
        dv.setUint8(off + 1, 0); // extended attr rec len
        dv.setUint32(off + 2, ROOT_DIR_LBA, true); // LBA of primary root
        dv.setUint16(off + 6, 1, true); // parent directory number
        dv.setUint8(off + 8, 0x00); // name = 0x00
        // pad to even
        dv.setUint8(off + 9, 0x00);
    }

    // Root Directory Data (primary)
    {
        const buf = serializeDirectory(rootRecordsFilled, SECTOR);
        image.set(buf, ROOT_DIR_LBA * SECTOR);
    }

    // Joliet Root Directory Data (UCS-2BE names)
    {
        const bufJ = serializeDirectory(jolietRecordsFilled, SECTOR);
        image.set(bufJ, JOLIET_ROOT_DIR_LBA * SECTOR);
    }

    // File data
    for (let i = 0; i < normFiles.length; i++) {
        const ex = fileExtents[i];
        const start = ex.lba * SECTOR;
        image.set(normFiles[i].data, start);
        // zero padding already present
    }

    return image;

    // --- helpers ---

    function writeA(buf, off, str, len) {
        const arr = new TextEncoder().encode(str);
        for (let i = 0; i < len; i++) {
            buf[off + i] = i < arr.length ? arr[i] : 0x20;
        }
    }
    // write UCS-2 BE string into buffer (no BOM), pad with 0x00 or 0x20 pairs as needed
    function writeUCS2BE(buf, off, str, lenBytes) {
        const enc = [];
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            enc.push((code >> 8) & 0xFF);
            enc.push(code & 0xFF);
        }
        for (let i = 0; i < lenBytes; i++) {
            buf[off + i] = i < enc.length ? enc[i] : 0x00;
        }
    }
    function isoDateString(d) {
        // YYYYMMDDHHMMSSccTZ (cc = centiseconds, TZ offset from GMT in 15-min intervals)
        const pad = (n, l=2) => String(n).padStart(l, '0');
        const tz = 0; // UTC
        return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}00${String.fromCharCode(tz + 0x30)}`.slice(0,17);
    }
    function makeDirectoryRecord(extentLBA, dataLength, flags, name, date) {
        // Primary (ASCII) directory record builder
        const nameBytes = (name.length === 1 && (name.charCodeAt(0) === 0 || name.charCodeAt(0) === 1))
            ? new Uint8Array([name.charCodeAt(0)])
            : new TextEncoder().encode(name);
        const lenDR = 33 + nameBytes.length + (nameBytes.length % 2 ? 1 : 0);
        const rec = new Uint8Array(lenDR);
        const dv = new DataView(rec.buffer);
        dv.setUint8(0, lenDR);
        dv.setUint8(1, 0); // Extent attr length
        dv.setUint32(2, extentLBA, true);
        dv.setUint32(6, extentLBA, false);
        dv.setUint32(10, dataLength, true);
        dv.setUint32(14, dataLength, false);
        // Recording date/time (7 bytes)
        const y = date.getUTCFullYear() - 1900;
        rec[18] = y & 0xFF;
        rec[19] = date.getUTCMonth() + 1;
        rec[20] = date.getUTCDate();
        rec[21] = date.getUTCHours();
        rec[22] = date.getUTCMinutes();
        rec[23] = date.getUTCSeconds();
        rec[24] = 0; // GMT offset in 15-min intervals (0 = GMT)
        rec[25] = flags; // 2 = directory, 0 = file
        rec[26] = 0; // file unit size
        rec[27] = 0; // interleave gap size
        dv.setUint16(28, 1, true); // volume sequence number LE
        dv.setUint16(30, 1, false); // volume sequence number BE
        rec[32] = nameBytes.length;
        rec.set(nameBytes, 33);
        if (nameBytes.length % 2 === 1) rec[33 + nameBytes.length] = 0; // padding
        return rec;
    }

    function makeDirectoryRecordJoliet(extentLBA, dataLength, flags, name, date) {
        // Joliet directory record: name is UCS-2BE encoded and name length counts bytes
        // name may be '\0' or '\1' for . and ..
        let nameBytes;
        if (name.length === 1 && (name.charCodeAt(0) === 0 || name.charCodeAt(0) === 1)) {
            nameBytes = new Uint8Array([name.charCodeAt(0)]);
        } else {
            // encode as UCS-2BE (no BOM)
            const arr = [];
            for (let i = 0; i < name.length; i++) {
                const c = name.charCodeAt(i);
                arr.push((c >> 8) & 0xFF);
                arr.push(c & 0xFF);
            }
            nameBytes = new Uint8Array(arr);
        }
        const lenDR = 33 + nameBytes.length + (nameBytes.length % 2 ? 1 : 0);
        const rec = new Uint8Array(lenDR);
        const dv = new DataView(rec.buffer);
        dv.setUint8(0, lenDR);
        dv.setUint8(1, 0); // Extent attr length
        dv.setUint32(2, extentLBA, true);
        dv.setUint32(6, extentLBA, false);
        dv.setUint32(10, dataLength, true);
        dv.setUint32(14, dataLength, false);
        // Recording date/time (7 bytes)
        const y = date.getUTCFullYear() - 1900;
        rec[18] = y & 0xFF;
        rec[19] = date.getUTCMonth() + 1;
        rec[20] = date.getUTCDate();
        rec[21] = date.getUTCHours();
        rec[22] = date.getUTCMinutes();
        rec[23] = date.getUTCSeconds();
        rec[24] = 0; // GMT offset in 15-min intervals (0 = GMT)
        rec[25] = flags; // 2 = directory, 0 = file
        rec[26] = 0; // file unit size
        rec[27] = 0; // interleave gap size
        dv.setUint16(28, 1, true); // volume sequence number LE
        dv.setUint16(30, 1, false); // volume sequence number BE
        rec[32] = nameBytes.length;
        rec.set(nameBytes, 33);
        if (nameBytes.length % 2 === 1) rec[33 + nameBytes.length] = 0; // padding to even
        return rec;
    }
    function computeDirSize(records) {
        // Sum of records with sector padding at end of each sector
        let size = 0;
        for (const r of records) {
            size += r.length;
        }
        // round up to sector boundary
        return padTo(size, SECTOR);
    }
    function serializeDirectory(records, sector) {
        // Pack records into contiguous bytes and pad to sector multiple
        let totalLen = 0;
        for (const r of records) totalLen += r.length;
        const size = padTo(totalLen, sector);
        const out = new Uint8Array(size);
        let p = 0;
        for (const r of records) {
            out.set(r, p);
            p += r.length;
        }
        // The rest remains zero
        return out;
    }
}