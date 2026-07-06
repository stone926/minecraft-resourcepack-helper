export interface OggMetadata {
  codec: "vorbis";
  channels: number;
  sampleRate: number;
  durationSeconds?: number;
}

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
