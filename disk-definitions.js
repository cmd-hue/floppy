export const DISK_DEFINITIONS = {
    '1.44MB': {
        name: '3.5" 1.44MB High Density',
        bytesPerSector: 512,
        sectorsPerTrack: 18,
        tracksPerCylinder: 2, // heads
        cylinders: 80,
        totalSectors: 2880, // 80 * 2 * 18
        mediaDescriptor: 0xF0,
        sectorsPerCluster: 1,
        reservedSectors: 1,
        fatCount: 2,
        rootDirectoryEntries: 224,
        sectorsPerFat: 9,
    },
    '720KB': {
        name: '3.5" 720KB Double Density',
        bytesPerSector: 512,
        sectorsPerTrack: 9,
        tracksPerCylinder: 2, // heads
        cylinders: 80,
        totalSectors: 1440, // 80 * 2 * 9
        mediaDescriptor: 0xF9,
        sectorsPerCluster: 2,
        reservedSectors: 1,
        fatCount: 2,
        rootDirectoryEntries: 112,
        sectorsPerFat: 3,
    },
    '1.2MB': {
        name: '5.25" 1.2MB High Density',
        bytesPerSector: 512,
        sectorsPerTrack: 15,
        tracksPerCylinder: 2, // heads
        cylinders: 80,
        totalSectors: 2400, // 80 * 2 * 15
        mediaDescriptor: 0xF9,
        sectorsPerCluster: 1,
        reservedSectors: 1,
        fatCount: 2,
        rootDirectoryEntries: 224,
        sectorsPerFat: 7,
    },
    '360KB': {
        name: '5.25" 360KB Double Density',
        bytesPerSector: 512,
        sectorsPerTrack: 9,
        tracksPerCylinder: 2, // heads
        cylinders: 40,
        totalSectors: 720, // 40 * 2 * 9
        mediaDescriptor: 0xFD,
        sectorsPerCluster: 2,
        reservedSectors: 1,
        fatCount: 2,
        rootDirectoryEntries: 112,
        sectorsPerFat: 2,
    },
};

