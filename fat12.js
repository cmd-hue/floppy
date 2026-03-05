/**
 * Creates a FAT12 disk image from a definition and a list of files.
 * @param {object} diskDef - A disk definition object from disk-definitions.js.
 * @param {Array<object>} files - An array of file objects.
 * @param {string} volumeLabel - The 11-char, space-padded upper-case volume label.
 * @returns {Uint8Array} The raw disk image data.
 */
export function createFAT12Image(diskDef, files, volumeLabel, bootSectorOverride) {
    const totalImageSize = diskDef.totalSectors * diskDef.bytesPerSector;
    const image = new Uint8Array(totalImageSize).fill(0);
    const view = new DataView(image.buffer);

    // --- 1. Create Boot Sector (BPB) ---
    // Fill BPB fields into a temporary boot sector buffer first so we can optionally merge with an override
    const bpBuf = new Uint8Array(diskDef.bytesPerSector).fill(0);
    const bpv = new DataView(bpBuf.buffer);

    // Jump + NOP (EB xx 90) -> standard and DOS 3.x friendly (default)
    bpv.setUint8(0, 0xEB);
    bpv.setUint8(1, 0x3C); // jump to offset 0x3E
    bpv.setUint8(2, 0x90);

    // OEM Identifier (use IBM 3.3 for maximum compatibility with older DOS)
    const oem = "IBM 3.3 ";
    for (let i = 0; i < 8; i++) bpv.setUint8(3 + i, oem.charCodeAt(i));

    // BPB common
    bpv.setUint16(11, diskDef.bytesPerSector, true); // BytsPerSec
    bpv.setUint8(13, diskDef.sectorsPerCluster);     // SecPerClus
    bpv.setUint16(14, diskDef.reservedSectors, true);// RsvdSecCnt
    bpv.setUint8(16, diskDef.fatCount);              // NumFATs
    bpv.setUint16(17, diskDef.rootDirectoryEntries, true); // RootEntCnt

    // Total sectors: choose 16-bit or 32-bit field correctly
    if (diskDef.totalSectors <= 0xFFFF) {
        bpv.setUint16(19, diskDef.totalSectors, true); // TotSec16
        bpv.setUint32(32, 0, true); // TotSec32 = 0
    } else {
        bpv.setUint16(19, 0, true);
        bpv.setUint32(32, diskDef.totalSectors, true);
    }

    bpv.setUint8(21, diskDef.mediaDescriptor);       // Media
    bpv.setUint16(22, diskDef.sectorsPerFat, true);  // FATSz16
    bpv.setUint16(24, diskDef.sectorsPerTrack, true);// SecPerTrk
    bpv.setUint16(26, diskDef.tracksPerCylinder, true); // NumHeads (heads)
    bpv.setUint32(28, 0, true); // HiddSec = 0

    // Extended BPB for DOS 4.0+ (still tolerated by DOS 3.x)
    bpv.setUint8(36, 0x00); // Drive number for floppy = 0x00
    bpv.setUint8(37, 0x00); // Reserved
    bpv.setUint8(38, 0x29); // Extended boot signature
    bpv.setUint32(39, Math.floor(Date.now() / 1000), true); // Volume serial

    // Volume Label (11 bytes)
    for (let i = 0; i < 11; i++) bpv.setUint8(43 + i, volumeLabel.charCodeAt(i) || 0x20);

    // Filesystem type (8 bytes, padded)
    const fsType = "FAT12   ";
    for (let i = 0; i < 8; i++) bpv.setUint8(54 + i, fsType.charCodeAt(i));

    // Default small boot code bytes at 0x3E are kept in bpBuf; they can be overwritten by bootSectorOverride if provided.

    // Boot signature (little-endian 0x55AA)
    bpv.setUint16(510, 0xAA55, true);

    // If a boot sector override was provided, merge it: copy the override into the boot sector,
    // but re-apply BPB fields to ensure consistency between boot code and disk geometry.
    if (bootSectorOverride && bootSectorOverride instanceof Uint8Array && bootSectorOverride.length >= diskDef.bytesPerSector) {
        // copy override into bpBuf
        bpBuf.set(bootSectorOverride.subarray(0, diskDef.bytesPerSector));
        // reapply the BPB fields that we just set so the BPB is authoritative
        const keepBPBFields = () => {
            bpv.setUint16(11, diskDef.bytesPerSector, true);
            bpv.setUint8(13, diskDef.sectorsPerCluster);
            bpv.setUint16(14, diskDef.reservedSectors, true);
            bpv.setUint8(16, diskDef.fatCount);
            bpv.setUint16(17, diskDef.rootDirectoryEntries, true);
            if (diskDef.totalSectors <= 0xFFFF) {
                bpv.setUint16(19, diskDef.totalSectors, true);
                bpv.setUint32(32, 0, true);
            } else {
                bpv.setUint16(19, 0, true);
                bpv.setUint32(32, diskDef.totalSectors, true);
            }
            bpv.setUint8(21, diskDef.mediaDescriptor);
            bpv.setUint16(22, diskDef.sectorsPerFat, true);
            bpv.setUint16(24, diskDef.sectorsPerTrack, true);
            bpv.setUint16(26, diskDef.tracksPerCylinder, true);
            bpv.setUint32(28, 0, true);
            bpv.setUint8(36, 0x00);
            bpv.setUint8(37, 0x00);
            bpv.setUint8(38, 0x29);
            bpv.setUint32(39, Math.floor(Date.now() / 1000), true);
            for (let i = 0; i < 11; i++) bpv.setUint8(43 + i, volumeLabel.charCodeAt(i) || 0x20);
            for (let i = 0; i < 8; i++) bpv.setUint8(54 + i, fsType.charCodeAt(i));
            bpv.setUint16(510, 0xAA55, true);
        };
        keepBPBFields();
    }

    // finally copy boot sector buffer into image
    image.set(bpBuf, 0);

    // --- 2. Create File Allocation Tables (FATs) ---
    const fatOffset = diskDef.reservedSectors * diskDef.bytesPerSector;
    const fatSize = diskDef.sectorsPerFat * diskDef.bytesPerSector;
    const fat = new Uint8Array(fatSize).fill(0);

    // FAT ID and reserved entries (clusters 0 and 1)
    fat[0] = diskDef.mediaDescriptor;
    fat[1] = 0xFF;
    fat[2] = 0xFF;

    let nextFreeCluster = 2; // Clusters 0 and 1 are reserved

    // Helper to write a 12-bit entry into the FAT
    function setFatEntry(cluster, value) {
        value &= 0xFFF; // clamp to 12 bits
        const offset = Math.floor(cluster * 1.5);
        if ((cluster & 1) === 0) {
            // even cluster
            fat[offset] = value & 0xFF;
            fat[offset + 1] = (fat[offset + 1] & 0xF0) | ((value >> 8) & 0x0F);
        } else {
            // odd cluster
            fat[offset] = (fat[offset] & 0x0F) | ((value << 4) & 0xF0);
            fat[offset + 1] = (value >> 4) & 0xFF;
        }
    }

    // --- 3. Prepare Root Directory and Data Area ---
    const rootDirOffset = fatOffset + (diskDef.fatCount * fatSize);
    const rootDirSectors = Math.ceil((diskDef.rootDirectoryEntries * 32) / diskDef.bytesPerSector);
    const dataAreaOffset = rootDirOffset + (rootDirSectors * diskDef.bytesPerSector);

    // --- Create Volume Label Entry in Root Directory ---
    const rootDirView = new DataView(image.buffer, rootDirOffset, rootDirSectors * diskDef.bytesPerSector);
    for (let i = 0; i < 11; i++) rootDirView.setUint8(i, volumeLabel.charCodeAt(i) || 0x20);
    rootDirView.setUint8(11, 0x08); // Attribute: Volume Label
    // Set date/time for volume label (optional, improves compatibility)
    const now = new Date();
    const fatTimeVL = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | Math.floor((now.getSeconds() & 59) / 2);
    const fatDateVL = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
    rootDirView.setUint16(22, fatTimeVL, true);
    rootDirView.setUint16(24, fatDateVL, true);

    let currentDirEntry = 1; // Start after volume label

    // --- 4. Write Files to Image ---
    // Compute maximum number of clusters available in data area
    const dataSectors = diskDef.totalSectors - (diskDef.reservedSectors + diskDef.fatCount * diskDef.sectorsPerFat + rootDirSectors);
    const maxClusters = Math.floor(dataSectors / diskDef.sectorsPerCluster);
    const maxFat12Cluster = 0xFEF; // 0xFF0..0xFFF are reserved/EOC in FAT12

    for (const file of files) {
        if (currentDirEntry >= diskDef.rootDirectoryEntries) {
            throw new Error("Exceeded maximum number of root directory entries.");
        }
        
        const clusterSizeBytes = diskDef.sectorsPerCluster * diskDef.bytesPerSector;
        const numClusters = Math.max(1, Math.ceil(file.size / clusterSizeBytes));

        if ((nextFreeCluster - 2) + numClusters > maxClusters) {
            throw new Error(`Not enough space for file: ${file.originalName}`);
        }
        if (nextFreeCluster + numClusters - 1 > maxFat12Cluster) {
            throw new Error("FAT12 cluster range exceeded.");
        }

        const startCluster = nextFreeCluster;
        
        // Write file data
        const fileOffsetInDataArea = (startCluster - 2) * clusterSizeBytes;
        if (file.content && file.content.length) {
            image.set(file.content, dataAreaOffset + fileOffsetInDataArea);
        }
        // Zero-pad last cluster remainder
        const written = file.size || 0;
        const remainder = written % clusterSizeBytes;
        if (remainder !== 0) {
            const padStart = dataAreaOffset + fileOffsetInDataArea + written;
            image.fill(0, padStart, padStart + (clusterSizeBytes - remainder));
        }

        // Update FAT chain
        for (let i = 0; i < numClusters; i++) {
            const currentCluster = startCluster + i;
            const nextClusterVal = (i === numClusters - 1) ? 0xFFF : currentCluster + 1; // EOC for last
            setFatEntry(currentCluster, nextClusterVal);
        }
        nextFreeCluster += numClusters;
        
        // Write Directory Entry
        const dirEntryOffset = currentDirEntry * 32;
        for (let i = 0; i < 11; i++) rootDirView.setUint8(dirEntryOffset + i, file.fatFileName.charCodeAt(i) || 0x20);
        rootDirView.setUint8(dirEntryOffset + 11, 0x20); // Attribute: Archive
        
        const modTime = file.lastModified || now;
        const fatTime = ((modTime.getHours() & 31) << 11) | ((modTime.getMinutes() & 63) << 5) | Math.floor((modTime.getSeconds() & 59) / 2);
        const fatDate = (((modTime.getFullYear() - 1980) & 127) << 9) | (((modTime.getMonth() + 1) & 15) << 5) | (modTime.getDate() & 31);

        rootDirView.setUint16(dirEntryOffset + 22, fatTime, true);
        rootDirView.setUint16(dirEntryOffset + 24, fatDate, true);
        rootDirView.setUint16(dirEntryOffset + 26, startCluster, true);
        rootDirView.setUint32(dirEntryOffset + 28, file.size >>> 0, true);

        currentDirEntry++;
    }

    // --- 5. Finalize ---
    // Copy FAT to all FAT tables
    const fatOffsetBytes = fatOffset;
    for (let i = 0; i < diskDef.fatCount; i++) {
        image.set(fat, fatOffsetBytes + i * fatSize);
    }
    
    return image;
}