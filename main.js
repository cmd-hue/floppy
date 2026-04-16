import { DISK_DEFINITIONS } from 'disk-definitions';
import { createFAT12Image } from 'fat12';
import { createISO9660Image } from 'iso9660';
import { createMBRWithFAT12Partitions } from 'mbr';

document.addEventListener('DOMContentLoaded', () => {
    const outputTypeSelect = document.getElementById('output-type');
    const diskTypeSelect = document.getElementById('disk-type');
    const fsTypeSelect = document.getElementById('fs-type');
    const fileInput = document.getElementById('file-input');
    const addFileBtn = document.getElementById('add-file-btn');
    const fileListEl = document.getElementById('file-list');
    const generateBtn = document.getElementById('generate-btn');
    const volumeLabelInput = document.getElementById('volume-label');
    const totalSizeEl = document.getElementById('total-size');
    const diskSizeEl = document.getElementById('disk-size');
    const capacityLine = document.getElementById('capacity-line');
    const progressBar = document.getElementById('progress-bar');
    const errorMessageEl = document.getElementById('error-message');
    const inspectBtn = document.getElementById('inspect-btn');
    const partitionCountGroup = document.getElementById('partition-count-group');
    const partitionCountInput = document.getElementById('partition-count');

    // Inspector elements
    const inspectorBackdrop = document.getElementById('inspector-backdrop');
    const inspectorClose = document.getElementById('inspector-close');
    const bpbDump = document.getElementById('bpb-dump');
    const fatSummary = document.getElementById('fat-summary');
    const rootDirPre = document.getElementById('root-dir');
    const compatChecks = document.getElementById('compat-checks');

    // virtualFiles is a tree: entries are { type: 'file'|'folder', name, ... }
    let virtualFiles = [];
    let currentPath = []; // array of folder names from root
    let currentDiskDef = null;

    // When importing an image file, preserve its first-sector boot code so generated images can remain bootable.
    let preservedBootSector = null;

    function init() {
        // Populate disk type selector
        Object.keys(DISK_DEFINITIONS).forEach(key => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = DISK_DEFINITIONS[key].name;
            diskTypeSelect.appendChild(option);
        });

        outputTypeSelect.addEventListener('change', updateModeVisibility);
        diskTypeSelect.addEventListener('change', updateDiskSelection);
        fsTypeSelect.addEventListener('change', updateUI);
        partitionCountInput.addEventListener('input', updateUI);

        addFileBtn.addEventListener('click', () => {
            // generic add: allow any file types (restores default accept)
            fileInput.accept = '.img,.iso,.ima,.flp,*/*';
            fileInput.multiple = true;
            // clear any replace marker
            delete fileInput.dataset.replaceIndex;
            fileInput.click();
        });

        // new button: import entire disk images (.img, .iso, .ima, .flp)
        const importImageBtn = document.getElementById('import-image-btn');
        if (importImageBtn) {
            importImageBtn.addEventListener('click', () => {
                // narrow accept to images and allow single or multiple imports
                fileInput.accept = '.img,.iso,.ima,.flp';
                fileInput.multiple = true;
                fileInput.click();
            });
        }

        // Import from URL button
        const importUrlBtn = document.getElementById('import-url-btn');
        if (importUrlBtn) {
            importUrlBtn.addEventListener('click', async () => {
                const url = prompt('Enter the URL of an .iso or .img file to import:');
                if (!url) return;
                try {
                    await fetchAndImportUrl(url);
                    updateUI();
                } catch (err) {
                    console.error('Import from URL failed:', err);
                    alert(`Failed to import from URL: ${err.message}`);
                }
            });
        }

        // Fetch a remote image and import its entries (ISO or FAT12 image)
        async function fetchAndImportUrl(url) {
            // Basic URL validation
            let parsed;
            try {
                parsed = new URL(url, location.href);
            } catch (e) {
                throw new Error('Invalid URL');
            }
            // Attempt to fetch the resource (CORS may block some hosts)
            const resp = await fetch(parsed.toString());
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const buf = new Uint8Array(await resp.arrayBuffer());
            const lower = parsed.pathname.toLowerCase();
            if (lower.endsWith('.iso')) {
                const entries = parseISOImageToEntries(buf, parsed.pathname);
                mergeEntriesIntoCurrentFolder(entries);
            } else if (lower.endsWith('.img') || lower.endsWith('.ima') || lower.endsWith('.flp')) {
                const entries = parseFAT12ImageToEntries(buf, parsed.pathname);
                mergeEntriesIntoCurrentFolder(entries);
            } else {
                // Try to detect by signatures: ISO 'CD001' at PVD or FAT BPB
                // ISO: 'CD001' at offset 16*2048 + 1
                const SECTOR_ISO = 2048;
                try {
                    const dv = new DataView(buf.buffer);
                    const pvdOff = 16 * SECTOR_ISO;
                    if (buf.length > pvdOff + 6) {
                        const ident = String.fromCharCode(...new Uint8Array(buf.buffer, pvdOff + 1, 5));
                        if (ident === 'CD001') {
                            const entries = parseISOImageToEntries(buf, parsed.pathname);
                            mergeEntriesIntoCurrentFolder(entries);
                            return;
                        }
                    }
                } catch (e) { /* ignore */ }
                // FAT: check for BPB bytes per sector at offset 11 (commonly 512)
                try {
                    const dv2 = new DataView(buf.buffer);
                    const bps = dv2.getUint16(11, true);
                    if (bps === 512) {
                        const entries = parseFAT12ImageToEntries(buf, parsed.pathname);
                        mergeEntriesIntoCurrentFolder(entries);
                        return;
                    }
                } catch (e) { /* ignore */ }

                throw new Error('Unknown or unsupported image type (not .iso/.img or unrecognized content)');
            }
        }

        document.getElementById('new-folder-btn').addEventListener('click', createNewFolder);
        fileInput.addEventListener('change', handleFileAdd);
        generateBtn.addEventListener('click', generateImage);
        fileListEl.addEventListener('click', handleFileClick);
        volumeLabelInput.addEventListener('input', updateUI);

        inspectBtn.addEventListener('click', openInspector);
        inspectorClose.addEventListener('click', closeInspector);
        inspectorBackdrop.addEventListener('click', (e) => {
            if (e.target === inspectorBackdrop) closeInspector();
        });

        // Ensure disk definition is available before first UI update
        updateDiskSelection();
        updateModeVisibility();
    }

    function updateModeVisibility() {
        const mode = outputTypeSelect.value;
        // Disk size selection is relevant for FAT12 and for MBR partitions (each partition size)
        diskTypeSelect.parentElement.style.display = (mode === 'floppy' || mode === 'mbr') ? '' : 'none';
        fsTypeSelect.parentElement.style.display = (mode === 'floppy' || mode === 'mbr') ? '' : 'none';
        partitionCountGroup.style.display = (mode === 'mbr') ? '' : 'none';
        capacityLine.setAttribute('data-mode', mode);

        updateUI();
    }

    function updateDiskSelection() {
        const selectedKey = diskTypeSelect.value;
        currentDiskDef = DISK_DEFINITIONS[selectedKey] || null;
        updateUI();
    }

    // Add file(s) into current folder; supports importing .img and .iso
    async function handleFileAdd(event) {
        errorMessageEl.textContent = '';
        // Check if this change was triggered to replace an existing file
        const replaceIndex = typeof fileInput.dataset.replaceIndex !== 'undefined' ? parseInt(fileInput.dataset.replaceIndex, 10) : null;
        const inputFiles = Array.from(event.target.files || []);
        // If replaceIndex is set, only consider the first selected file to replace the target
        if (replaceIndex !== null && inputFiles.length > 0) {
            const file = inputFiles[0];
            const name = file.name || 'unnamed';
            try {
                const content = new Uint8Array(await file.arrayBuffer());
                // locate folder and entry
                const folder = getFolderAtPath(currentPath) || virtualFiles;
                const entry = folder[replaceIndex];
                if (!entry || entry.type !== 'file') {
                    throw new Error('Target entry to replace is not a file');
                }
                // replace fields in-place
                entry.content = content;
                entry.size = content.length;
                entry.originalName = name;
                entry.name = name;
                entry.lastModified = new Date(file.lastModified);
            } catch (e) {
                console.error('Replace error:', e);
                alert(`Failed to replace file: ${e.message}`);
            } finally {
                // clear replace marker
                delete fileInput.dataset.replaceIndex;
                fileInput.value = '';
                updateUI();
                return;
            }
        }

        // Normal add/import flow (unchanged)
        const files = inputFiles;
        for (const file of files) {
            const name = file.name || 'unnamed';
            const lower = name.toLowerCase();
            try {
                if (lower.endsWith('.iso')) {
                    const arr = new Uint8Array(await file.arrayBuffer());
                    const entries = parseISOImageToEntries(arr, name);
                    mergeEntriesIntoCurrentFolder(entries);
                    // ISO boot catalog/boot image preservation is out of scope; clear preserved FAT boot sector
                    preservedBootSector = null;
                } else if (lower.endsWith('.img') || lower.endsWith('.ima') || lower.endsWith('.flp')) {
                    const arr = new Uint8Array(await file.arrayBuffer());
                    // preserve first sector (boot sector) from imported image for later generation
                    if (arr.length >= 512) preservedBootSector = new Uint8Array(arr.subarray(0, 512));
                    const entries = parseFAT12ImageToEntries(arr, name);
                    mergeEntriesIntoCurrentFolder(entries);
                } else {
                    // regular file
                    const content = new Uint8Array(await file.arrayBuffer());
                    const entry = {
                        type: 'file',
                        name,
                        originalName: name,
                        size: content.length,
                        content,
                        lastModified: new Date(file.lastModified)
                    };
                    addEntryToCurrentFolder(entry);
                    // adding normal files should not implicitly preserve any previous boot sector
                    // (user can re-import an image to restore boot code)
                }
            } catch (e) {
                console.error('Import error:', e);
                alert(`Failed to import "${name}": ${e.message}`);
            }
        }

        fileInput.value = '';
        updateUI();
    }

    function toFAT11_3(filename) {
        const parts = filename.split('.');
        const ext = parts.length > 1 ? parts.pop().toUpperCase() : '';
        const name = parts.join('.').toUpperCase();

        const sanitizedName = name.replace(/[^A-Z0-9]/g, '').substring(0, 8);
        const sanitizedExt = ext.replace(/[^A-Z0-9]/g, '').substring(0, 3);
        
        return `${sanitizedName.padEnd(8, ' ')}${sanitizedExt.padEnd(3, ' ')}`;
    }

    // Helpers for folder management
    function getFolderAtPath(path) {
        let nodeList = virtualFiles;
        for (const part of path) {
            const next = nodeList.find(n => n.type === 'folder' && n.name === part);
            if (!next) return null;
            nodeList = next.children;
        }
        return nodeList;
    }
    function addEntryToCurrentFolder(entry) {
        const folder = getFolderAtPath(currentPath) || virtualFiles;
        folder.push(entry);
    }
    function mergeEntriesIntoCurrentFolder(entries) {
        const folder = getFolderAtPath(currentPath) || virtualFiles;
        for (const e of entries) folder.push(e);
    }

    function handleFileClick(e) {
        // delegation: remove, replace, download, open folder, or noop
        const target = e.target;
        if (target.classList.contains('remove-btn')) {
            const index = parseInt(target.dataset.index, 10);
            const folder = getFolderAtPath(currentPath) || virtualFiles;
            folder.splice(index, 1);
            updateUI();
            return;
        }
        if (target.classList.contains('replace-btn')) {
            // trigger file input to replace this entry (single file only)
            const index = parseInt(target.dataset.index, 10);
            fileInput.accept = '*/*';
            fileInput.multiple = false;
            fileInput.dataset.replaceIndex = String(index);
            fileInput.click();
            return;
        }
        if (target.classList.contains('download-btn')) {
            const index = parseInt(target.dataset.index, 10);
            const folder = getFolderAtPath(currentPath) || virtualFiles;
            const entry = folder[index];
            if (entry && entry.type === 'file') {
                const blob = new Blob([entry.content || new Uint8Array(0)], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = entry.originalName || entry.name || 'file.bin';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }
            return;
        }
        // folder open
        const li = target.closest('li');
        if (!li) return;
        const idx = parseInt(li.dataset.index, 10);
        const folder = getFolderAtPath(currentPath) || virtualFiles;
        const entry = folder[idx];
        if (entry && entry.type === 'folder') {
            currentPath.push(entry.name);
            updateUI();
        }
    }

    function renderFileList() {
        fileListEl.innerHTML = '';
        const folder = getFolderAtPath(currentPath) || virtualFiles;
        if (!folder || folder.length === 0) {
            const li = document.createElement('li');
            li.textContent = 'No files or folders here.';
            li.style.color = '#888';
            li.style.fontStyle = 'italic';
            fileListEl.appendChild(li);
        } else {
            folder.forEach((entry, index) => {
                const li = document.createElement('li');
                li.setAttribute('data-index', index);
                if (entry.type === 'folder') {
                    li.innerHTML = `
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M10 4H4a2 2 0 0 0-2 2v2h20V8a2 2 0 0 0-2-2h-10zM2 10v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6H2z"/>
                        </svg>
                        <span class="file-name folder-name">${entry.name}</span>
                        <span class="file-size">—</span>
                        <button class="remove-btn" data-index="${index}">&times;</button>
                    `;
                } else {
                    // Add small Download and Replace buttons next to Remove to act on file entries
                    li.innerHTML = `
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                          <path d="M4 0h5l3 3v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2zM9.5 3A1.5 1.5 0 0 1 8 1.5V1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5h-2z"/>
                        </svg>
                        <span class="file-name">${entry.originalName || entry.name}</span>
                        <span class="file-size">${(entry.size || 0).toLocaleString()} B</span>
                        <button class="download-btn" data-index="${index}" title="Download file">↓</button>
                        <button class="replace-btn" data-index="${index}" title="Replace file">&crarr;</button>
                        <button class="remove-btn" data-index="${index}">&times;</button>
                    `;
                }
                fileListEl.appendChild(li);
            });
        }
    }

    function updateUI() {
        renderFileList();

        const mode = outputTypeSelect.value;
        // compute total size as sum of files in tree
        const totalSize = sumSizesInTree(virtualFiles);
        // update breadcrumb display
        updateBreadcrumbs();

        // If mode requires a disk definition but it's not ready yet, bail safely
        if ((mode === 'floppy' || mode === 'mbr') && !currentDiskDef) {
            totalSizeEl.textContent = totalSize.toLocaleString();
            diskSizeEl.textContent = '0';
            document.querySelector('.progress-bar-container').style.visibility = 'hidden';
            errorMessageEl.textContent = '';
            generateBtn.disabled = true;
            return;
        }

        // Defaults for UI
        let error = '';
        let availableSpace = 0;
        let showProgress = true;

        if (mode === 'floppy') {
            const diskSize = currentDiskDef.totalSectors * currentDiskDef.bytesPerSector;
            const systemOverheadBytes =
                (currentDiskDef.reservedSectors +
                 currentDiskDef.fatCount * currentDiskDef.sectorsPerFat +
                 Math.ceil((currentDiskDef.rootDirectoryEntries * 32) / currentDiskDef.bytesPerSector)
                ) * currentDiskDef.bytesPerSector;
            availableSpace = diskSize - systemOverheadBytes;

            const usageRatio = totalSize / availableSpace;
            progressBar.style.width = `${Math.min(usageRatio * 100, 100)}%`;
            const isOverCapacity = totalSize > availableSpace;
            progressBar.classList.toggle('full', isOverCapacity);

            if (isOverCapacity) {
                error = "Total file size exceeds disk capacity.";
            } else if (virtualFiles.length > currentDiskDef.rootDirectoryEntries - 1) {
                // -1 because we create one Volume Label entry in root
                error = `Too many files. This format supports a maximum of ${currentDiskDef.rootDirectoryEntries - 1} files in the root directory (one entry is the volume label).`;
            }
            diskSizeEl.textContent = availableSpace.toLocaleString();
            capacityLine.style.display = '';
        } else if (mode === 'iso') {
            // ISO9660 is sized automatically; we hide bar or set based on heuristic (files only)
            showProgress = false;
            progressBar.style.width = '0%';
            progressBar.classList.remove('full');
            diskSizeEl.textContent = 'auto';
            capacityLine.style.display = '';
        } else if (mode === 'mbr') {
            // MBR total capacity = partitions × selected disk size (roughly)
            const partitions = clamp(parseInt(partitionCountInput.value || '1', 10), 1, 4);
            const partitionSectors = currentDiskDef.totalSectors;
            const bytesPerSector = currentDiskDef.bytesPerSector;
            const approxUsablePerPart =
                partitionSectors * bytesPerSector
                - ((currentDiskDef.reservedSectors +
                   currentDiskDef.fatCount * currentDiskDef.sectorsPerFat +
                   Math.ceil((currentDiskDef.rootDirectoryEntries * 32) / bytesPerSector)
                  ) * bytesPerSector);
            availableSpace = approxUsablePerPart * partitions;

            const usageRatio = totalSize * partitions > 0 ? (totalSize / approxUsablePerPart) : 0;
            progressBar.style.width = `${Math.min(usageRatio * 100, 100)}%`;
            const isOverCapacity = totalSize > approxUsablePerPart;
            progressBar.classList.toggle('full', isOverCapacity);
            if (isOverCapacity) {
                error = `Files exceed per-partition capacity. Each partition can hold ~${approxUsablePerPart.toLocaleString()} bytes.`;
            } else if (virtualFiles.length > currentDiskDef.rootDirectoryEntries - 1) {
                error = `Too many files for a FAT12 partition. Max ${currentDiskDef.rootDirectoryEntries - 1} (one entry is the volume label).`;
            }
            diskSizeEl.textContent = (approxUsablePerPart * partitions).toLocaleString();
            capacityLine.style.display = '';
        }

        totalSizeEl.textContent = totalSize.toLocaleString();

        // Progress bar visibility
        document.querySelector('.progress-bar-container').style.visibility = showProgress ? 'visible' : 'hidden';

        errorMessageEl.textContent = error;
        generateBtn.disabled = virtualFiles.length === 0 || !!error;
    }
    
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    
    function generateImage() {
        errorMessageEl.textContent = '';
        const mode = outputTypeSelect.value;
        const rawLabelFloppy = (volumeLabelInput.value || "NO NAME").toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 11);
        const volumeLabelFAT = rawLabelFloppy.padEnd(11, ' ');
        const volumeLabelISO = (volumeLabelInput.value || "CDROM").toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 32);

        try {
            let imageData;
            let fileName = 'image.bin';
            if (mode === 'floppy') {
                // flatten files from tree (we place all files into root for now)
                const flat = collectFilesForImage(virtualFiles);
                // If the user imported a bootable image earlier we preserve its first 512-byte sector
                imageData = createFAT12Image(currentDiskDef, flat, volumeLabelFAT, preservedBootSector);
                fileName = 'floppy.img';
            } else if (mode === 'iso') {
                const flat = collectFilesForImage(virtualFiles);
                imageData = createISO9660Image(flat, volumeLabelISO);
                fileName = 'disc.iso';
            } else if (mode === 'mbr') {
                const partitions = clamp(parseInt(partitionCountInput.value || '1', 10), 1, 4);
                const flat = collectFilesForImage(virtualFiles);
                // Pass preservedBootSector down so partition boot code can be retained
                imageData = createMBRWithFAT12Partitions(currentDiskDef, flat, volumeLabelFAT, partitions, preservedBootSector);
                fileName = `disk_${partitions}p.img`;
            }

            const blob = new Blob([imageData], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

        } catch (e) {
            console.error('Failed to generate image:', e);
            errorMessageEl.textContent = `Error: ${e.message}`;
        }
    }

    // --- Helper utilities for tree and import/parsing ---
    function sumSizesInTree(nodes) {
        let sum = 0;
        for (const n of nodes) {
            if (n.type === 'file') sum += (n.size || 0);
            else if (n.type === 'folder') sum += sumSizesInTree(n.children || []);
        }
        return sum;
    }
    function collectFilesForImage(nodes) {
        // flatten into { originalName, content, size, lastModified, fatFileName }
        const out = [];
        (function walk(list) {
            for (const n of list) {
                if (n.type === 'file') {
                    const originalName = n.originalName || n.name;
                    out.push({
                        originalName,
                        content: n.content || new Uint8Array(0),
                        size: n.size || 0,
                        lastModified: n.lastModified || new Date(),
                        fatFileName: toFAT11_3(originalName)
                    });
                } else if (n.type === 'folder') {
                    walk(n.children || []);
                }
            }
        })(nodes);
        return out;
    }

    // --- Parsers for importing images (basic) ---
    function parseISOImageToEntries(isoBytes, sourceName) {
        // Recursive ISO parser with safeguards against pathological images that reference
        // directories in cycles or use self-referencing LBAs. Tracks visited LBAs and
        // enforces a recursion depth limit to avoid maximum call stack exhaustion.
        const SECTOR = 2048;
        const dv = new DataView(isoBytes.buffer);
        const pvdOff = 16 * SECTOR;
        const ident = String.fromCharCode(...new Uint8Array(isoBytes.buffer, pvdOff + 1, 5));
        if (ident !== 'CD001') throw new Error('Not a valid ISO9660 image');

        const rootRecOff = pvdOff + 156;
        const rootLBA = dv.getUint32(rootRecOff + 2, true);
        const rootSize = dv.getUint32(rootRecOff + 10, true);

        function readString(off, len) {
            return String.fromCharCode(...new Uint8Array(isoBytes.buffer, off, len)).replace(/\u0000/g, ' ').trim();
        }

        const visitedLBAs = new Set();
        const MAX_RECURSION_DEPTH = 128; // generous cap for normal images

        function parseDirectory(lba, size, depth = 0) {
            // Safety: prevent cycles and overly deep recursion
            if (depth > MAX_RECURSION_DEPTH) return [];
            if (visitedLBAs.has(lba)) return [];
            visitedLBAs.add(lba);

            const start = lba * SECTOR;
            const end = start + size;
            const items = [];
            let p = start;
            // Guard against invalid offsets
            if (start < 0 || start >= isoBytes.length) return items;
            while (p < end && p < isoBytes.length) {
                const len = dv.getUint8(p);
                if (len === 0) { p = Math.ceil((p + 1) / SECTOR) * SECTOR; continue; }
                // Basic sanity check
                if (len < 1 || p + len > isoBytes.length) break;

                const nameLen = dv.getUint8(p + 32);
                let name = readString(p + 33, nameLen);
                // '.' and '..' are 0x00 and 0x01
                if (name === '\u0000' || name === '\u0001') { p += len; continue; }
                // strip version ;1
                name = name.replace(/;1$/i, '');
                const entryLBA = dv.getUint32(p + 2, true);
                const entrySize = dv.getUint32(p + 10, true);
                const flags = dv.getUint8(p + 25);
                const isDir = !!(flags & 0x02);

                if (isDir) {
                    // ignore impossible LBAs or zero-length dirs
                    if (entryLBA === 0 || entrySize === 0 || entryLBA * SECTOR >= isoBytes.length) {
                        items.push({ type: 'folder', name, children: [] });
                    } else {
                        const children = parseDirectory(entryLBA, entrySize, depth + 1);
                        items.push({ type: 'folder', name, children });
                    }
                } else {
                    // guard read bounds
                    const dataStart = entryLBA * SECTOR;
                    if (dataStart >= 0 && dataStart + entrySize <= isoBytes.length) {
                        const data = new Uint8Array(isoBytes.buffer, dataStart, entrySize);
                        items.push({ type: 'file', name, originalName: name, size: entrySize, content: new Uint8Array(data), lastModified: new Date() });
                    } else {
                        // skip invalid file entry
                        items.push({ type: 'file', name, originalName: name, size: 0, content: new Uint8Array(0), lastModified: new Date() });
                    }
                }
                p += len;
            }
            return items;
        }

        return parseDirectory(rootLBA, rootSize, 0);
    }

    function parseFAT12ImageToEntries(imgBytes, sourceName) {
        // Parse root directory and recurse into subdirectories by following cluster chains.
        const dv = new DataView(imgBytes.buffer);
        const bpbBytesPerSec = dv.getUint16(11, true);
        if (bpbBytesPerSec !== 512) throw new Error('Unsupported sector size for FAT import');
        const rsvd = dv.getUint16(14, true);
        const numFATs = dv.getUint8(16);
        const rootEnt = dv.getUint16(17, true);
        const fatsz = dv.getUint16(22, true);
        const sectorsPerCluster = dv.getUint8(13);
        const rootDirSectors = Math.ceil((rootEnt * 32) / bpbBytesPerSec);
        const fatStartByte = rsvd * bpbBytesPerSec;
        const fatSizeBytes = fatsz * bpbBytesPerSec;
        const rootStart = (rsvd + numFATs * fatsz) * bpbBytesPerSec;
        const rootSize = rootDirSectors * bpbBytesPerSec;
        const dataStart = rootStart + rootSize;
        const fat0 = new Uint8Array(imgBytes.buffer, fatStartByte, fatSizeBytes);

        function getFat12Entry(cluster) {
            const off = Math.floor(cluster * 1.5);
            if ((cluster & 1) === 0) {
                return fat0[off] | ((fat0[off + 1] & 0x0F) << 8);
            } else {
                return ((fat0[off] & 0xF0) >> 4) | (fat0[off + 1] << 4);
            }
        }

        function readClusterChain(startClus) {
            if (startClus < 2) return new Uint8Array(0);
            const clusterSize = sectorsPerCluster * bpbBytesPerSec;
            const parts = [];
            let cur = startClus;
            const maxIter = 10000;
            let iter = 0;
            while (cur < 0xFF8 && cur !== 0x000 && iter++ < maxIter) {
                const offset = dataStart + (cur - 2) * clusterSize;
                // guard bounds
                const available = Math.max(0, Math.min(clusterSize, imgBytes.length - offset));
                if (available <= 0) break;
                parts.push(new Uint8Array(imgBytes.buffer, offset, available));
                const next = getFat12Entry(cur);
                if (next >= 0xFF8) break;
                cur = next;
            }
            const total = parts.reduce((s, p) => s + p.length, 0);
            const out = new Uint8Array(total);
            let pos = 0;
            for (const p of parts) { out.set(p, pos); pos += p.length; }
            return out;
        }

        function parseDirectoryFromBuffer(buf) {
            const items = [];
            const rview = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
            const lenEntries = Math.floor(rview.length / 32);
            for (let i = 0; i < lenEntries; i++) {
                const off = i * 32;
                const first = rview[off];
                if (first === 0x00) break;
                if (first === 0xE5) continue;
                const attr = rview[off + 11];
                if (attr & 0x08) continue; // volume label
                const name = String.fromCharCode(...rview.slice(off, off + 8)).trim();
                const ext = String.fromCharCode(...rview.slice(off + 8, off + 11)).trim();
                const filename = ext ? `${name}.${ext}` : name;
                const startClus = rview[off + 26] | (rview[off + 27] << 8);
                const size = rview[off + 28] | (rview[off + 29] << 8) | (rview[off + 30] << 16) | (rview[off + 31] << 24);
                if (attr & 0x10) {
                    // directory: read its cluster chain and parse entries recursively
                    if (startClus === 0) {
                        // special case: some FATs use cluster 0 for root (skip)
                        items.push({ type: 'folder', name, children: [] });
                    } else {
                        const dirBuf = readClusterChain(startClus);
                        const children = parseDirectoryFromBuffer(dirBuf);
                        items.push({ type: 'folder', name, children });
                    }
                } else {
                    if (startClus === 0) continue;
                    const fileBuf = readClusterChain(startClus).slice(0, size);
                    items.push({ type: 'file', name: filename, originalName: filename, size, content: new Uint8Array(fileBuf), lastModified: new Date() });
                }
            }
            return items;
        }

        // Parse root directory area first (root is not in clusters but in rootStart/rootSize)
        const rootBuf = new Uint8Array(imgBytes.buffer, rootStart, rootSize);
        return parseDirectoryFromBuffer(rootBuf);
    }

    // folder creation and breadcrumbs
    function createNewFolder() {
        const name = prompt('New folder name:');
        if (!name) return;
        const folder = { type: 'folder', name, children: [] };
        addEntryToCurrentFolder(folder);
        updateUI();
    }
    function updateBreadcrumbs() {
        // small breadcrumb UI inside fm-header (create if needed)
        let bc = document.getElementById('fm-breadcrumbs');
        if (!bc) {
            bc = document.createElement('div');
            bc.id = 'fm-breadcrumbs';
            bc.style.marginTop = '8px';
            bc.style.fontSize = '0.9em';
            bc.style.color = '#555';
            document.querySelector('.fm-header').appendChild(bc);
        }
        bc.innerHTML = '';
        const rootBtn = document.createElement('button');
        rootBtn.textContent = 'Root';
        rootBtn.style.marginRight = '6px';
        rootBtn.addEventListener('click', () => { currentPath = []; updateUI(); });
        bc.appendChild(rootBtn);
        let acc = [];
        currentPath.forEach((p, i) => {
            acc.push(p);
            const btn = document.createElement('button');
            btn.textContent = p;
            btn.style.marginRight = '6px';
            btn.addEventListener('click', () => { currentPath = acc.slice(0, i+1); updateUI(); });
            bc.appendChild(btn);
        });
    }

        function openInspector() {
            const mode = outputTypeSelect.value;
            try {
                if (mode === 'floppy') {
                    const rawLabel = (volumeLabelInput.value || "NO NAME").toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 11).padEnd(11, ' ');
                    const flat = collectFilesForImage(virtualFiles);
                    const img = createFAT12Image(currentDiskDef, flat, rawLabel, preservedBootSector);
                    populateInspectorFAT12(img, currentDiskDef);
                } else if (mode === 'iso') {
                    const vol = (volumeLabelInput.value || "CDROM").toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 32);
                    const flat = collectFilesForImage(virtualFiles);
                    const iso = createISO9660Image(flat, vol);
                    populateInspectorISO9660(iso);
                } else {
                    const rawLabel = (volumeLabelInput.value || "NO NAME").toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 11).padEnd(11, ' ');
                    const parts = clamp(parseInt(partitionCountInput.value || '2', 10), 1, 4);
                    const flat = collectFilesForImage(virtualFiles);
                    const img = createMBRWithFAT12Partitions(currentDiskDef, flat, rawLabel, parts, preservedBootSector);
                    populateInspectorMBR(img, currentDiskDef, parts);
                }
                inspectorBackdrop.classList.remove('hidden');
            } catch (e) {
                alert(`Cannot inspect: ${e.message}`);
            }
        }

        function closeInspector() {
            inspectorBackdrop.classList.add('hidden');
        }

    function populateInspectorFAT12(img, def) {
        const dv = new DataView(img.buffer);

        // BPB summary
        const bpb = {
            OEM: String.fromCharCode(...img.slice(3, 11)),
            BytsPerSec: dv.getUint16(11, true),
            SecPerClus: dv.getUint8(13),
            RsvdSecCnt: dv.getUint16(14, true),
            NumFATs: dv.getUint8(16),
            RootEntCnt: dv.getUint16(17, true),
            TotSec16: dv.getUint16(19, true),
            Media: '0x' + dv.getUint8(21).toString(16).toUpperCase(),
            FATSz16: dv.getUint16(22, true),
            SecPerTrk: dv.getUint16(24, true),
            NumHeads: dv.getUint16(26, true),
            HiddSec: dv.getUint32(28, true),
            TotSec32: dv.getUint32(32, true),
            BootSig: '0x' + dv.getUint16(510, true).toString(16).toUpperCase()
        };
        const totSec = bpb.TotSec16 || bpb.TotSec32;
        const rootDirSectors = Math.ceil((bpb.RootEntCnt * 32) / bpb.BytsPerSec);
        const fatStart = bpb.RsvdSecCnt * bpb.BytsPerSec;
        const fatSizeBytes = bpb.FATSz16 * bpb.BytsPerSec;
        const dataStart = (bpb.RsvdSecCnt + bpb.NumFATs * bpb.FATSz16 + rootDirSectors) * bpb.BytsPerSec;

        bpbDump.textContent =
`OEM: ${bpb.OEM}
Bytes/Sector: ${bpb.BytsPerSec}
Sectors/Cluster: ${bpb.SecPerClus}
Reserved Sectors: ${bpb.RsvdSecCnt}
FATs: ${bpb.NumFATs}
Root Entries: ${bpb.RootEntCnt}
Total Sectors: ${totSec}
Media Descriptor: ${bpb.Media}
Sectors/FAT: ${bpb.FATSz16}
Sectors/Track: ${bpb.SecPerTrk}
Heads: ${bpb.NumHeads}
Hidden Sectors: ${bpb.HiddSec}
Boot Signature (55AA): ${bpb.BootSig}
Offsets:
  FAT#0: ${fatStart} bytes
  RootDir: ${(bpb.RsvdSecCnt + bpb.NumFATs * bpb.FATSz16) * bpb.BytsPerSec} bytes
  Data: ${dataStart} bytes
`;

        // FAT summary (scan first few clusters)
        const fat0 = new Uint8Array(img.buffer, fatStart, fatSizeBytes);
        function getFat12Entry(cluster) {
            const off = Math.floor(cluster * 1.5);
            if ((cluster & 1) === 0) {
                return fat0[off] | ((fat0[off + 1] & 0x0F) << 8);
            } else {
                return ((fat0[off] & 0xF0) >> 4) | (fat0[off + 1] << 4);
            }
        }
        const lines = [];
        lines.push(`FAT[0..2]: ${[fat0[0], fat0[1], fat0[2]].map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
        for (let c = 2; c < 12; c++) {
            lines.push(`Cluster ${c}: 0x${getFat12Entry(c).toString(16).toUpperCase()}`);
        }
        fatSummary.textContent = lines.join('\n');

        // Root Directory entries (first 16)
        const rootStart = (bpb.RsvdSecCnt + bpb.NumFATs * bpb.FATSz16) * bpb.BytsPerSec;
        const rootSize = rootDirSectors * bpb.BytsPerSec;
        const root = new Uint8Array(img.buffer, rootStart, rootSize);
        const rootLines = [];
        for (let i = 0; i < Math.min(bpb.RootEntCnt, 16); i++) {
            const off = i * 32;
            const first = root[off];
            if (first === 0x00) {
                rootLines.push(`[${i}] <empty>`);
                continue;
            }
            const name = String.fromCharCode(...root.slice(off, off + 11));
            const attr = root[off + 11];
            const startClus = (root[off + 27] << 8) | root[off + 26];
            const size = (root[off + 31] << 24) | (root[off + 30] << 16) | (root[off + 29] << 8) | root[off + 28];
            rootLines.push(`[${i}] ${name} ATTR=0x${attr.toString(16).toUpperCase()} CLUS=${startClus} SIZE=${size}`);
        }
        rootDirPre.textContent = rootLines.join('\n');

        // Compatibility checks for DOS 3.x
        const pushCheck = (ok, msg) => {
            const li = document.createElement('li');
            li.textContent = (ok ? '✓ ' : '⨯ ') + msg;
            li.style.color = ok ? '#2c7a7b' : '#c53030';
            compatChecks.appendChild(li);
        };
        pushCheck(bpb.BytsPerSec === 512, 'Bytes per sector = 512');
        pushCheck(bpb.SecPerClus >= 1 && bpb.SecPerClus <= 4, 'Sectors per cluster in expected range for 1.44MB (1..4)');
        pushCheck(bpb.RsvdSecCnt === 1, 'Reserved sectors = 1');
        pushCheck(bpb.NumFATs === 2, 'Two FATs present');
        pushCheck((new DataView(img.buffer)).getUint16(510, true) === 0xAA55, 'Boot signature 0x55AA present');
        pushCheck(img.length === def.totalSectors * def.bytesPerSector, 'Image size matches BPB total sectors');
    }

    function populateInspectorISO9660(iso) {
        const dv = new DataView(iso.buffer);
        // Primary Volume Descriptor at sector >=16
        const sectorSize = 2048;
        const pvdOffset = 16 * sectorSize;
        const typeCode = dv.getUint8(pvdOffset + 0);
        const ident = String.fromCharCode(
            dv.getUint8(pvdOffset + 1),
            dv.getUint8(pvdOffset + 2),
            dv.getUint8(pvdOffset + 3),
            dv.getUint8(pvdOffset + 4),
            dv.getUint8(pvdOffset + 5)
        );
        const version = dv.getUint8(pvdOffset + 6);
        const sysId = readA(pvdOffset + 8, 32);
        const volId = readA(pvdOffset + 40, 32).trim();
        const volSpaceLE = dv.getUint32(pvdOffset + 80, true);
        const volSpaceBE = dv.getUint32(pvdOffset + 84, false);
        const volSetSize = dv.getUint16(pvdOffset + 120, true);
        const volSeqNum = dv.getUint16(pvdOffset + 124, true);
        const logicalBlkSize = dv.getUint16(pvdOffset + 128, true);
        const pathTableSize = dv.getUint32(pvdOffset + 132, true);
        const lPathTableLBA = dv.getUint32(pvdOffset + 140, true);

        bpbDump.textContent =
`PVD Type: ${typeCode}  Ident: ${ident}  Ver: ${version}
System ID: ${sysId}
Volume ID: ${volId}
Volume Space Size (LE/BE): ${volSpaceLE} / ${volSpaceBE} blocks
Logical Block Size: ${logicalBlkSize}
Path Table Size: ${pathTableSize}
L Path Table LBA: ${lPathTableLBA}
`;

        // Path table (first few entries)
        const pathTableStart = lPathTableLBA * sectorSize;
        const lines = [];
        let off = pathTableStart;
        let idx = 1;
        while (off < pathTableStart + Math.min(pathTableSize, 512)) {
            const len = dv.getUint8(off);
            if (!len) break;
            const ext = dv.getUint8(off + 1);
            const lba = dv.getUint32(off + 2, true);
            const parent = dv.getUint16(off + 6, true);
            const name = readA(off + 8, len);
            lines.push(`#${idx} "${name}" LBA=${lba} Parent=${parent}`);
            const recLen = 8 + len + (len % 2 ? 1 : 0) + (ext ? ext : 0);
            off += recLen;
            idx++;
        }
        fatSummary.textContent = lines.join('\n') || '(path table small or empty)';

        // Root directory records (list files)
        const rootDirRecordOffset = pvdOffset + 156;
        const rootLba = dv.getUint32(rootDirRecordOffset + 2, true);
        const rootSize = dv.getUint32(rootDirRecordOffset + 10, true);
        const rootStart = rootLba * sectorSize;
        const rootEnd = rootStart + rootSize;
        const rootLines = [];
        let p = rootStart;
        while (p < rootEnd) {
            const len = dv.getUint8(p);
            if (len === 0) { // skip to next sector
                p = Math.ceil((p + 1) / sectorSize) * sectorSize;
                continue;
            }
            const lba = dv.getUint32(p + 2, true);
            const dataLen = dv.getUint32(p + 10, true);
            const flags = dv.getUint8(p + 25);
            const nameLen = dv.getUint8(p + 32);
            let name = readA(p + 33, nameLen);
            if (name === '\u0000') name = '.';
            if (name === '\u0001') name = '..';
            rootLines.push(`${(flags & 2) ? 'DIR ' : 'FILE'} ${name} LBA=${lba} SIZE=${dataLen}`);
            p += len;
        }
        rootDirPre.textContent = rootLines.join('\n');

        // Checks
        compatChecks.innerHTML = '';
        const pushCheck = (ok, msg) => {
            const li = document.createElement('li');
            li.textContent = (ok ? '✓ ' : '⨯ ') + msg;
            li.style.color = ok ? '#2c7a7b' : '#c53030';
            compatChecks.appendChild(li);
        };
        pushCheck(typeCode === 1 && ident === 'CD001' && version === 1, 'Primary Volume Descriptor present');
        pushCheck(logicalBlkSize === 2048, 'Logical block size = 2048');
        function readA(offset, len) {
            return String.fromCharCode(...new Uint8Array(iso.buffer, offset, len)).replace(/\u0000/g, ' ').trimEnd();
        }
    }

    function populateInspectorMBR(img, def, parts) {
        const dv = new DataView(img.buffer);
        const sig = dv.getUint16(510, true);
        bpbDump.textContent = `MBR Signature: 0x${sig.toString(16).toUpperCase()}  (expect 0xAA55)
Partitions: ${parts}
Each partition type: 0x01 (FAT12), starting at CHS ignored, using LBA fields.
`;

        const lines = [];
        for (let i = 0; i < 4; i++) {
            const base = 446 + i * 16;
            const type = dv.getUint8(base + 4);
            const startLBA = dv.getUint32(base + 8, true);
            const sectors = dv.getUint32(base + 12, true);
            if (type !== 0) {
                lines.push(`#${i + 1}: type=0x${type.toString(16).padStart(2,'0').toUpperCase()} startLBA=${startLBA} sectors=${sectors}`);
            } else {
                lines.push(`#${i + 1}: <empty>`);
            }
        }
        fatSummary.textContent = lines.join('\n');

        // Root of first partition (peek BPB)
        if (parts > 0) {
            const sectorSize = 512;
            const p0StartLBA = dv.getUint32(446 + 8, true);
            const p0Offset = p0StartLBA * sectorSize;
            const BytsPerSec = dv.getUint16(p0Offset + 11, true);
            const SecPerClus = dv.getUint8(p0Offset + 13);
            rootDirPre.textContent = `Partition #1 BPB: Bytes/Sector=${BytsPerSec} Sec/Clus=${SecPerClus}`;
        } else {
            rootDirPre.textContent = '';
        }

        compatChecks.innerHTML = '';
        const pushCheck = (ok, msg) => {
            const li = document.createElement('li');
            li.textContent = (ok ? '✓ ' : '⨯ ') + msg;
            li.style.color = ok ? '#2c7a7b' : '#c53030';
            compatChecks.appendChild(li);
        };
        pushCheck(sig === 0xAA55, 'MBR signature 0x55AA present');
    }

    init();
});