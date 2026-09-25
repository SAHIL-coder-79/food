const mockProvider = require('../src/ai/foodQuality/mockProvider');
const service = require('../src/ai/foodQuality/service');
const { getProvider } = require('../src/ai/foodQuality/provider');

// Pure, DB-free tests: the mock provider's determinism and the service's image-decoding/validation logic.
// (Full API-level behaviour - auth, organization isolation, HTTP status codes - is in foodQualityApi.test.js.)

const VALID_CLASSIFICATIONS = ['FRESH', 'USE_SOON', 'QUESTIONABLE', 'UNKNOWN'];

function fakePng(size = 5000, fill = 0xab) {
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length), fill)]);
}
function fakeJpeg(size = 5000, fill = 0x42) {
    const header = Buffer.from([0xff, 0xd8, 0xff]);
    return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length), fill)]);
}
function fakeWebp(size = 5000, fill = 0x11) {
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(Math.max(0, size - 8), 4);
    header.write('WEBP', 8, 'ascii');
    return Buffer.concat([header, Buffer.alloc(Math.max(0, size - 12), fill)]);
}

describe('FoodQualityProvider abstraction', () => {
    it('getProvider() defaults to the mock provider, and rejects an unknown one', () => {
        expect(getProvider()).toBe(mockProvider);
        expect(getProvider('mock')).toBe(mockProvider);
        expect(() => getProvider('some-real-cv-model')).toThrow(/Unknown food quality provider/);
    });

    it('the mock provider identifies itself, so the API response can report which provider ran', () => {
        expect(mockProvider.name).toBe('mock');
    });
});

describe('mockProvider.assess - deterministic behaviour', () => {
    it('gives the exact same result for the exact same image bytes, every time', () => {
        const buffer = fakeJpeg(8000);
        const first = mockProvider.assess({ buffer, format: 'jpeg' });
        for (let i = 0; i < 5; i += 1) {
            expect(mockProvider.assess({ buffer, format: 'jpeg' })).toEqual(first);
        }
    });

    it('is a pure function of the bytes: two equal-content buffers (even different instances) agree', () => {
        const a = mockProvider.assess({ buffer: fakePng(6000, 0x77) });
        const b = mockProvider.assess({ buffer: fakePng(6000, 0x77) });
        expect(a).toEqual(b);
    });

    it('different images can (and, over enough samples, do) get different results - it is not a constant', () => {
        const results = new Set();
        for (let i = 0; i < 40; i += 1) {
            const r = mockProvider.assess({ buffer: fakeJpeg(5000 + i * 37, i) });
            results.add(r.classification);
        }
        expect(results.size).toBeGreaterThan(1);
    });

    it('never returns a classification outside the documented set', () => {
        for (let i = 0; i < 60; i += 1) {
            const r = mockProvider.assess({ buffer: fakePng(4000 + i * 53, i) });
            expect(VALID_CLASSIFICATIONS).toContain(r.classification);
        }
    });

    it('confidence is always a finite number strictly between 0 and 1 (never a claim of certainty)', () => {
        for (let i = 0; i < 60; i += 1) {
            const r = mockProvider.assess({ buffer: fakeWebp(4000 + i * 61, i) });
            expect(Number.isFinite(r.confidence)).toBe(true);
            expect(r.confidence).toBeGreaterThan(0);
            expect(r.confidence).toBeLessThan(1);
        }
    });

    it('always returns at least one signal and a non-empty recommendation, for every classification', () => {
        for (let i = 0; i < 60; i += 1) {
            const r = mockProvider.assess({ buffer: fakeJpeg(3500 + i * 41, i) });
            expect(Array.isArray(r.signals)).toBe(true);
            expect(r.signals.length).toBeGreaterThan(0);
            expect(r.signals.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
            expect(typeof r.recommendation).toBe('string');
            expect(r.recommendation.length).toBeGreaterThan(0);
        }
    });

    it('never repeats the same signal twice within one result', () => {
        for (let i = 0; i < 60; i += 1) {
            const r = mockProvider.assess({ buffer: fakePng(4200 + i * 29, i) });
            expect(new Set(r.signals).size).toBe(r.signals.length);
        }
    });

    it('a UNKNOWN result always has a low confidence, consistent with "not confident enough to say more"', () => {
        let sawUnknown = false;
        for (let i = 0; i < 200; i += 1) {
            const r = mockProvider.assess({ buffer: fakeJpeg(6000 + i * 97, i) });
            if (r.classification === 'UNKNOWN') {
                sawUnknown = true;
                expect(r.confidence).toBeLessThanOrEqual(0.4);
            }
        }
        expect(sawUnknown).toBe(true); // UNKNOWN must be a reachable outcome, not a dead branch
    });

    it('a very small/low-detail image always returns UNKNOWN, regardless of its exact bytes', () => {
        for (let i = 0; i < 10; i += 1) {
            const r = mockProvider.assess({ buffer: fakePng(50 + i, i) });
            expect(r.classification).toBe('UNKNOWN');
            expect(r.signals.some((s) => /too small|low-detail/i.test(s))).toBe(true);
        }
    });
});

describe('service.sniffImageFormat', () => {
    it('recognises PNG, JPEG and WEBP from their magic bytes', () => {
        expect(service.sniffImageFormat(fakePng())).toBe('png');
        expect(service.sniffImageFormat(fakeJpeg())).toBe('jpeg');
        expect(service.sniffImageFormat(fakeWebp())).toBe('webp');
    });

    it('returns null for bytes that do not match any supported signature', () => {
        expect(service.sniffImageFormat(Buffer.from('not an image at all, just text', 'utf8'))).toBeNull();
        expect(service.sniffImageFormat(Buffer.alloc(0))).toBeNull();
        expect(service.sniffImageFormat(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBeNull();
    });

    it('is not fooled by a RIFF file that is not actually WEBP', () => {
        const riffButNotWebp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')]);
        expect(service.sniffImageFormat(riffButNotWebp)).toBeNull();
    });
});

describe('service.decodeImage - image input validation', () => {
    const asBase64 = (buf) => buf.toString('base64');

    it('accepts a well-formed, correctly-sized, supported image and returns its sniffed format', () => {
        const buffer = fakeJpeg(5000);
        const result = service.decodeImage({ imageBase64: asBase64(buffer), mimeType: 'image/jpeg' });
        expect(result.format).toBe('jpeg');
        expect(result.buffer.equals(buffer)).toBe(true);
    });

    it('rejects a missing or empty imageBase64', () => {
        expect(() => service.decodeImage({ imageBase64: undefined, mimeType: 'image/jpeg' })).toThrow(/imageBase64 is required/);
        expect(() => service.decodeImage({ imageBase64: '', mimeType: 'image/jpeg' })).toThrow(/imageBase64 is required/);
    });

    it('rejects a string that is not valid base64', () => {
        expect(() => service.decodeImage({ imageBase64: 'not-base64-!!!***', mimeType: 'image/jpeg' })).toThrow(/valid base64/i);
    });

    it('rejects an unsupported or missing mimeType before even looking at the bytes', () => {
        expect(() => service.decodeImage({ imageBase64: asBase64(fakeJpeg()), mimeType: 'image/gif' })).toThrow(/mimeType must be one of/);
        expect(() => service.decodeImage({ imageBase64: asBase64(fakeJpeg()), mimeType: undefined })).toThrow(/mimeType must be one of/);
        expect(() => service.decodeImage({ imageBase64: asBase64(fakeJpeg()), mimeType: 'application/pdf' })).toThrow(/mimeType must be one of/);
    });

    it('rejects bytes that do not sniff as a supported image, even with a valid declared mimeType', () => {
        const notAnImage = Buffer.from('this is just plain text pretending to be a photo, repeated '.repeat(5), 'utf8');
        expect(() => service.decodeImage({ imageBase64: asBase64(notAnImage), mimeType: 'image/png' })).toThrow(/does not look like a supported image format/);
    });

    it('rejects data too small to be a valid image', () => {
        expect(() => service.decodeImage({ imageBase64: asBase64(Buffer.from([1, 2, 3])), mimeType: 'image/png' })).toThrow(/too small/);
    });

    it('rejects an oversized image with a clear, specific message', () => {
        const huge = fakeJpeg(service.MAX_IMAGE_BYTES + 1);
        expect(() => service.decodeImage({ imageBase64: asBase64(huge), mimeType: 'image/jpeg' })).toThrow(/too large/i);
    });

    it('accepts an image exactly at the maximum allowed size', () => {
        const atLimit = fakePng(service.MAX_IMAGE_BYTES);
        expect(() => service.decodeImage({ imageBase64: asBase64(atLimit), mimeType: 'image/png' })).not.toThrow();
    });
});
