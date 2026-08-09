export interface OggMetadata {
  codec: "vorbis";
  channels: number;
  sampleRate: number;
  durationSeconds?: number;
}

/** Vorbis I requires its 30-byte identification packet alone on a 58-byte first page. */
export const oggVorbisIdentificationPageBytes = 58;

/** Ogg's 255 lacing entries bound one physical page to 65,307 bytes. */
export const oggMaximumPageBytes = 65_307;

export function readOggMetadata(input: Uint8Array): OggMetadata | null {
  const bytes = Buffer.from(input);
  let offset = 0;
  let firstPacket: Buffer | null = null;
  let currentPacket: Buffer[] = [];
  let lastGranule: bigint | null = null;

  while (offset + 27 <= bytes.length) {
    if (bytes.toString("ascii", offset, offset + 4) !== "OggS") {
      return null;
    }
    const pageSegments = bytes[offset + 26];
    const segmentTableOffset = offset + 27;
    const bodyOffset = segmentTableOffset + pageSegments;
    if (bodyOffset > bytes.length) {
      return null;
    }

    let bodyLength = 0;
    for (let index = 0; index < pageSegments; index++) {
      bodyLength += bytes[segmentTableOffset + index];
    }
    if (bodyOffset + bodyLength > bytes.length) {
      return null;
    }

    const granule = readOggGranulePosition(bytes, offset + 6);
    if (granule !== null) {
      lastGranule = granule;
    }

    let bodyCursor = bodyOffset;
    for (let index = 0; index < pageSegments; index++) {
      const segmentLength = bytes[segmentTableOffset + index];
      currentPacket.push(bytes.subarray(bodyCursor, bodyCursor + segmentLength));
      bodyCursor += segmentLength;
      if (segmentLength < 255) {
        firstPacket ??= Buffer.concat(currentPacket);
        currentPacket = [];
      }
    }

    offset = bodyOffset + bodyLength;
  }

  if (!firstPacket) {
    return null;
  }
  return readVorbisIdentification(firstPacket, lastGranule);
}

/**
 * Reads Vorbis metadata from independently bounded head and tail windows.
 * The head owns codec/channel/rate identity; the final complete page owns the
 * granule position used for duration.
 */
export function readOggMetadataFromHeadAndTail(
  headInput: Uint8Array,
  tailInput: Uint8Array
): OggMetadata | null {
  const identified = readOggMetadata(headInput);
  if (!identified) {
    return null;
  }

  const metadata: OggMetadata = {
    codec: identified.codec,
    channels: identified.channels,
    sampleRate: identified.sampleRate
  };
  const finalPage = readFinalOggPage(Buffer.from(tailInput));
  const firstStreamSerial = readOggStreamSerial(Buffer.from(headInput), 0);
  if (
    finalPage
    && finalPage.granule !== null
    && finalPage.streamSerial !== null
    && firstStreamSerial === finalPage.streamSerial
  ) {
    metadata.durationSeconds = Number(finalPage.granule) / metadata.sampleRate;
  }
  return metadata;
}

function readVorbisIdentification(packet: Buffer, lastGranule: bigint | null): OggMetadata | null {
  if (packet.length < 30 || packet[0] !== 1 || packet.toString("ascii", 1, 7) !== "vorbis") {
    return null;
  }
  const channels = packet[11];
  const sampleRate = packet.readUInt32LE(12);
  if (!Number.isInteger(channels) || channels <= 0 || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    return null;
  }

  const metadata: OggMetadata = {
    codec: "vorbis",
    channels,
    sampleRate
  };
  if (lastGranule !== null) {
    metadata.durationSeconds = Number(lastGranule) / sampleRate;
  }
  return metadata;
}

function readOggGranulePosition(bytes: Buffer, offset: number): bigint | null {
  let value = 0n;
  for (let index = 7; index >= 0; index--) {
    value = (value << 8n) + BigInt(bytes[offset + index]);
  }
  return value === 0xffffffffffffffffn ? null : value;
}

function readFinalOggPage(
  bytes: Buffer
): { granule: bigint | null; streamSerial: number | null } | null {
  for (let offset = bytes.length - 27; offset >= 0; offset--) {
    if (bytes.toString("ascii", offset, offset + 4) !== "OggS") {
      continue;
    }
    const pageSegments = bytes[offset + 26];
    const segmentTableOffset = offset + 27;
    const bodyOffset = segmentTableOffset + pageSegments;
    if (bodyOffset > bytes.length) {
      continue;
    }

    let bodyLength = 0;
    for (let index = 0; index < pageSegments; index++) {
      bodyLength += bytes[segmentTableOffset + index];
    }
    if (bodyOffset + bodyLength !== bytes.length) {
      continue;
    }
    return {
      granule: readOggGranulePosition(bytes, offset + 6),
      streamSerial: readOggStreamSerial(bytes, offset)
    };
  }
  return null;
}

function readOggStreamSerial(bytes: Buffer, pageOffset: number): number | null {
  return pageOffset + 18 <= bytes.length
    ? bytes.readUInt32LE(pageOffset + 14)
    : null;
}
