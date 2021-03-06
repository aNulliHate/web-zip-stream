import ZipTransformerEntry from './zip-transformer-entry'
import Crc32 from './crc32.js'
import constants from './constants'
import ArrayBufferStream from '../util/arraybuffer-stream'
import { getDateTimeDOS } from './util'

class ZipTransformer implements Transformer {
    private forceZip64: boolean;
    private entry?: ZipTransformerEntry;
    private entries: Map<string, ZipTransformerEntry>;

    private offset: bigint;
    private centralOffset: bigint;
    private centralSize: bigint;

    constructor() {
        this.forceZip64 = false;
        this.entries = new Map<string, ZipTransformerEntry>();

        this.offset = BigInt(0);
        this.centralOffset = BigInt(0);
        this.centralSize = BigInt(0);
    }

    async transform(entry: any, ctrl: TransformStreamDefaultController) {
        // DEFINE ENTRY
        this.entry = this.entries.set(entry.name, new ZipTransformerEntry(entry.name, this.offset, entry)).get(entry.name)!;
        console.log(this, this.entry, this.entries);
        // LOCAL FILE HEADER
        // 30 bytes + file name length + extra field length
        const localFileHeader = new ArrayBufferStream(30 + this.entry.nameBuffer.length + this.entry.extra.length)
            .writeInt32(constants.SIG_LFH)
            .writeInt16(0x002D)
            .writeInt16(0x0808)
            .writeInt16(0x0000)
            .writeInt32(getDateTimeDOS(this.entry.date)) // 4 bytes
            .writeInt32(0x00000000)
            .writeInt32(0x00000000)
            .writeInt32(0x00000000)
            .writeInt16(this.entry.nameBuffer.length)
            .writeInt16(0)
            .writeBytes(this.entry.nameBuffer)
            .writeBytes(this.entry.extra);
        ctrl.enqueue(localFileHeader.getTypedArray());
        this.offset += BigInt(localFileHeader.byteLength);
        // FILE DATA
        if (entry.stream) {
            const reader = entry.stream().getReader();
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                this.entry.crc.append(value);
                this.entry.compressedSize += BigInt(value.length);
                this.entry.size += BigInt(value.length);
                ctrl.enqueue(value)
            }
        }
        // DATA DESCRIPTOR
        // if zip64 size will be 20 bytes
        let dataDescriptor = new ArrayBufferStream(this.entry.isZip64() ? 20 : 16)
            .writeInt32(constants.SIG_DD)
            .writeInt32(this.entry.crc.get());
        if (this.entry.isZip64()) {
            dataDescriptor
                .writeBigInt64(this.entry.compressedSize)
                .writeBigInt64(this.entry.size);
        } else {
            dataDescriptor
                .writeInt32(this.entry.compressedSize)
                .writeInt32(this.entry.size);
        }
        ctrl.enqueue(dataDescriptor.getTypedArray());
        this.offset += this.entry.size + BigInt(dataDescriptor.byteLength)
    }
    flush(ctrl: TransformStreamDefaultController) {
        // CENTRAL DIRECTORY FILE HEADER
        this.centralOffset = this.offset;
        this.entries.forEach((entry: ZipTransformerEntry) => {
            let fileOffset = entry.offset;
            let size = entry.size;
            let compressedSize = entry.compressedSize;

            if (entry.isZip64() || entry.offset > constants.ZIP64_MAGIC) {
                fileOffset = BigInt(constants.ZIP64_MAGIC);
                size = BigInt(constants.ZIP64_MAGIC);
                compressedSize = BigInt(constants.ZIP64_MAGIC);

                // 32 bytes
                const createZip64ExtraField = new ArrayBufferStream(32)
                    .writeInt16(constants.ZIP64_EXTRA_ID)
                    .writeInt16(24)
                    .writeBigInt64(entry.size) // 8
                    .writeBigInt64(entry.compressedSize)
                    .writeBigInt64(entry.offset)
                    .writeInt32(0x0000); // disk start number
                entry.extra = createZip64ExtraField.getTypedArray()
            }
            // 46 bytes + file name length + extra field length
            const centralDirectoryFileHeader = new ArrayBufferStream(46 + entry.nameBuffer.length + entry.extra.length)
                .writeInt32(constants.SIG_CFH)
                .writeInt16(0x002D)
                .writeInt16(0x002D)
                .writeInt16(0x0808)
                .writeInt16(0x0000)
                .writeInt32(getDateTimeDOS(entry.date))
                .writeInt32(entry.crc.get())
                .writeInt32(compressedSize)
                .writeInt32(size)
                .writeInt16(entry.nameBuffer.length)
                .writeInt16(entry.extra.length) // extra field length
                .writeInt16(0x0000)
                .writeInt16(0x0000)
                .writeInt16(0x0000)
                .writeInt32(0x00000000)
                .writeInt32(fileOffset)
                .writeBytes(entry.nameBuffer)
                .writeBytes(entry.extra);
            ctrl.enqueue(centralDirectoryFileHeader.getTypedArray());
            this.offset += BigInt(centralDirectoryFileHeader.byteLength);
        });
        this.centralSize = this.offset - this.centralOffset;
        // ZIP64 END OF CENTRAL DIRECTORY RECORD / LOCATOR
        if (this.isZip64()) {
            // RECORD
            // 56 bytes
            const zip64EOCDirectoryRecord = new ArrayBufferStream(56)
                .writeInt32(constants.SIG_ZIP64_EOCD)
                .writeBigInt64(44)
                .writeInt16(0x002D)
                .writeInt16(0x002D)
                .writeInt32(0)
                .writeInt32(0)
                .writeBigInt64(this.entries.size)
                .writeBigInt64(this.entries.size)
                .writeBigInt64(this.centralSize)
                .writeBigInt64(this.centralOffset);
            ctrl.enqueue(zip64EOCDirectoryRecord.getTypedArray());
            this.offset += BigInt(zip64EOCDirectoryRecord.byteLength);
            // LOCATOR
            // 20 bytes
            const zip64EOCDirectoryLocator = new ArrayBufferStream(20)
                .writeInt32(constants.SIG_ZIP64_EOCD_LOC)
                .writeInt32(0)
                .writeBigInt64(this.centralOffset + this.centralSize)
                .writeInt32(1);
            ctrl.enqueue(zip64EOCDirectoryLocator.getTypedArray());
            this.offset += BigInt(zip64EOCDirectoryLocator.byteLength);

        }
        // END OF CENTRAL DIRECTORY RECORD
        let entriesSize = this.entries.size;
        let centralSize = this.centralSize;
        let centralOffset = this.centralOffset;
        if (this.isZip64()) {
            entriesSize = constants.ZIP64_MAGIC_SHORT;
            // @ts-ignore
            centralSize = constants.ZIP64_MAGIC;
            // @ts-ignore
            centralOffset = constants.ZIP64_MAGIC;
        }
        const endOfCentralDirectoryRecord = new ArrayBufferStream(22)
            .writeInt32(constants.SIG_EOCD)
            .writeInt16(0)
            .writeInt16(0)
            .writeInt16(entriesSize)
            .writeInt16(entriesSize)
            .writeInt32(centralSize)
            .writeInt32(centralOffset)
            .writeInt16(0);
        ctrl.enqueue(endOfCentralDirectoryRecord.getTypedArray());
        this.offset += BigInt(endOfCentralDirectoryRecord.byteLength)
    }
    isZip64() {
        return this.forceZip64 || this.entries.size > constants.ZIP64_MAGIC_SHORT || this.centralSize > constants.ZIP64_MAGIC || this.centralOffset > constants.ZIP64_MAGIC;
    }
}

export default ZipTransformer
