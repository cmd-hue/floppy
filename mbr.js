/**
 * Compose a raw disk image with an MBR and multiple FAT12 partitions.
 * Each partition is a complete FAT12 volume created from the same files.
 * - Partition type: 0x01 (FAT12)
 * - Starts at LBA 63 for DOS-era compatibility; subsequent partitions are contiguous.
 * - CHS fields set to zeros (many OSes use LBA fields).
 * @param {object} diskDef FAT12 disk definition (from disk-definitions)
 * @param {Array<object>} files file list (same structure used by FAT builder)
 * @param {string} volumeLabel 11-char padded
 * @param {number} partitionCount 1..4
 * @returns {Uint8Array}
 */
import { createFAT12Image } from 'fat12';

export function createMBRWithFAT12Partitions(diskDef, files, volumeLabel, partitionCount, bootSectorOverride) {
    const parts = Math.max(1, Math.min(4, partitionCount | 0));
    const bytesPerSector = 512;
    const partSectors = diskDef.totalSectors;
    const partBytes = partSectors * bytesPerSector;

    // Build the FAT12 partition payload once, passing any preserved boot sector
    const partImage = createFAT12Image(diskDef, files, volumeLabel, bootSectorOverride);
    if (partImage.length !== partBytes) {
        throw new Error('Partition image size mismatch.');
    }

    const startLBA0 = 63;
    const table = [];
    for (let i = 0; i < parts; i++) {
        const startLBA = startLBA0 + i * partSectors;
        table.push({ startLBA, sectors: partSectors, type: 0x01, bootable: i === 0 ? 0x80 : 0x00 });
    }
    const totalSectors = startLBA0 + parts * partSectors;
    const image = new Uint8Array(totalSectors * bytesPerSector); // zeroed
    const dv = new DataView(image.buffer);

    // Write MBR signature
    dv.setUint16(510, 0xAA55, true);

    // Write partition table
    for (let i = 0; i < 4; i++) {
        const base = 446 + i * 16;
        if (i < table.length) {
            const p = table[i];
            dv.setUint8(base + 0, p.bootable); // boot indicator
            // CHS start (not accurate; set to placeholder)
            dv.setUint8(base + 1, 0x00);
            dv.setUint8(base + 2, 0x02);
            dv.setUint8(base + 3, 0x00);
            dv.setUint8(base + 4, p.type);
            // CHS end (placeholder)
            dv.setUint8(base + 5, 0xFE);
            dv.setUint8(base + 6, 0xFF);
            dv.setUint8(base + 7, 0xFF);
            dv.setUint32(base + 8, p.startLBA, true);
            dv.setUint32(base + 12, p.sectors, true);
        } else {
            // empty
            for (let j = 0; j < 16; j++) dv.setUint8(base + j, 0x00);
        }
    }

    // Copy partitions into place
    for (let i = 0; i < parts; i++) {
        const start = table[i].startLBA * bytesPerSector;
        image.set(partImage, start);
    }

    return image;
}