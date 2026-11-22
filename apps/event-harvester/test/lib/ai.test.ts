import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AiResponseParseError, extractTextFromImage, generateSummary, generateEventInfos, type AiEnv } from '../../src/lib/ai.js';
import type { PreviewContent, RssItem } from '../../src/types.js';

// Mock fetch globally
const fetchMock = vi.fn();
global.fetch = fetchMock;

function gatewayReply(content: string, finishReason = 'stop') {
  return {
    ok: true,
    json: () => Promise.resolve({
      choices: [{ finish_reason: finishReason, message: { content } }],
    }),
  };
}

function gatewayOk(content: unknown) {
  return gatewayReply(JSON.stringify(content));
}

function gatewayError(status = 500, body = 'Internal Server Error') {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
  };
}

describe('AI Module', () => {
  let mockEnv: AiEnv;

  beforeEach(() => {
    mockEnv = {
      AI_GATEWAY_URL: 'https://gateway.ai.cloudflare.com/v1/account/gateway/openai/chat/completions',
      AI_GATEWAY_TOKEN: 'gateway-token',
      OPENAI_MODEL: 'test-image-model',
    };
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateSummary', () => {
    it('should generate summary successfully', async () => {
      fetchMock.mockResolvedValueOnce(gatewayOk({
        summary: '공지사항 요약',
        highlights: ['중요 포인트 1', '중요 포인트 2'],
        actionItems: ['행동 항목 1'],
        links: ['http://example.com'],
      }));

      const result = await generateSummary(mockEnv, {
        title: '테스트 공지',
        description: '공지 내용',
        previewText: '미리보기 텍스트',
        attachmentText: '첨부 텍스트',
        link: 'http://example.com',
        pubDate: '2023-01-01',
      });

      expect(result).toEqual({
        summary: '공지사항 요약',
        highlights: ['중요 포인트 1', '중요 포인트 2'],
        actionItems: ['행동 항목 1'],
        links: ['http://example.com'],
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(mockEnv.AI_GATEWAY_URL);
      expect(init.headers['cf-aig-authorization']).toBe('Bearer gateway-token');
      expect(init.headers).not.toHaveProperty('Authorization');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(init.body);
      expect(body.model).toBe(mockEnv.OPENAI_MODEL);
      expect(body.stream).toBe(false);
      expect(body.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: { strict: true, schema: { type: 'object' } },
      });
    });

    it('should return fallback on AI Gateway error', async () => {
      fetchMock.mockResolvedValueOnce(gatewayError());

      const result = await generateSummary(mockEnv, {
        title: '테스트',
        description: '내용',
        link: 'http://example.com',
        pubDate: '2023-01-01',
      });

      expect(result).toEqual({
        summary: '요약 정보를 생성하지 못했습니다.',
        highlights: [],
        actionItems: [],
        links: [],
      });
    });

    it('should handle malformed JSON response', async () => {
      fetchMock.mockResolvedValueOnce(gatewayReply('invalid json'));

      const result = await generateSummary(mockEnv, {
        title: '테스트',
        description: '내용',
        link: 'http://example.com',
        pubDate: '2023-01-01',
      });

      expect(result).toEqual({
        summary: '요약 정보를 생성하지 못했습니다.',
        highlights: [],
        actionItems: [],
        links: [],
      });
    });

    it('should handle partial JSON response', async () => {
      fetchMock.mockResolvedValueOnce(gatewayOk({
        summary: '요약',
        highlights: 'not an array', // Invalid type
        actionItems: ['valid item'],
      }));

      const result = await generateSummary(mockEnv, {
        title: '테스트',
        description: '내용',
        link: 'http://example.com',
        pubDate: '2023-01-01',
      });

      expect(result).toEqual({
        summary: '요약',
        highlights: [],
        actionItems: ['valid item'],
        links: [],
      });
    });
  });

  describe('extractTextFromImage', () => {
    it('should extract text from image successfully', async () => {
      fetchMock.mockResolvedValueOnce(gatewayOk({ extractedText: '추출된 텍스트' }));

      const preview: PreviewContent = {
        sourceType: 'image',
        imageBase64: 'base64-image-data',
        contentType: 'image/png',
      };

      const result = await extractTextFromImage(mockEnv, preview);

      expect(result).toBe('추출된 텍스트');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(mockEnv.AI_GATEWAY_URL);
      expect(init.headers['cf-aig-authorization']).toBe('Bearer gateway-token');
      expect(init.headers).not.toHaveProperty('Authorization');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(init.body);
      expect(body.model).toBe(mockEnv.OPENAI_MODEL);
      const userMessage = body.messages[1];
      expect(userMessage.content).toContainEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,base64-image-data' },
      });
    });

    it('should avoid sending an unsupported image type to AI Gateway', async () => {
      const preview: PreviewContent = {
        sourceType: 'image',
        imageBase64: 'data',
        contentType: 'image/svg+xml',
      };

      expect(await extractTextFromImage(mockEnv, preview)).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should return undefined for non-image content', async () => {
      const preview: PreviewContent = {
        sourceType: 'text',
        text: 'some text',
      };

      const result = await extractTextFromImage(mockEnv, preview);
      expect(result).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should return undefined for image without base64 data', async () => {
      const preview: PreviewContent = {
        sourceType: 'image',
      };

      const result = await extractTextFromImage(mockEnv, preview);
      expect(result).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects on AI Gateway error so the caller can retry the image', async () => {
      fetchMock.mockResolvedValueOnce(gatewayError(429, 'Rate limited'));

      const preview: PreviewContent = {
        sourceType: 'image',
        imageBase64: 'data',
      };

      await expect(extractTextFromImage(mockEnv, preview)).rejects.toThrow('AI Gateway request failed (429)');
    });

    it('should handle malformed OCR JSON response', async () => {
      fetchMock.mockResolvedValueOnce(gatewayReply('not json'));

      const preview: PreviewContent = {
        sourceType: 'image',
        imageBase64: 'data',
      };

      await expect(extractTextFromImage(mockEnv, preview)).rejects.toThrow(SyntaxError);
    });

    it('should handle OCR response without extractedText', async () => {
      fetchMock.mockResolvedValueOnce(gatewayOk({ otherField: 'value' }));

      const preview: PreviewContent = {
        sourceType: 'image',
        imageBase64: 'data',
      };

      await expect(extractTextFromImage(mockEnv, preview)).rejects.toThrow('AI Gateway returned no image extraction');
    });
  });

  describe('generateEventInfos', () => {
    let mockItem: RssItem;

    beforeEach(() => {
      mockItem = {
        id: '123',
        title: '2025학년도 봄학기 수강신청',
        link: 'https://example.com/notice/123',
        pubDate: '2025-10-28',
        descriptionHtml: '<p>수강신청 일정: 2025-11-01 ~ 2025-11-03</p>',
      };
    });

    it('should generate event infos with single event', async () => {
      fetchMock.mockResolvedValueOnce(gatewayOk({
        events: [
          {
            title: '수강신청',
            description: '봄학기 수강신청',
            startDate: '2025-11-01',
            endDate: '2025-11-03',
            startTime: null,
            endTime: null,
          },
        ],
      }));

      const result = await generateEventInfos(mockEnv, mockItem);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        title: '수강신청',
        description: '봄학기 수강신청',
        startDate: '2025-11-01',
        endDate: '2025-11-03',
        startTime: undefined,
        endTime: undefined,
      });
    });

    it('should generate event infos with multiple events', async () => {
      fetchMock.mockResolvedValueOnce(gatewayOk({
        events: [
          {
            title: '행사 1',
            description: '설명 1',
            startDate: '2025-11-01',
            endDate: '2025-11-01',
            startTime: null,
            endTime: null,
          },
          {
            title: '행사 2',
            description: '설명 2',
            startDate: '2025-11-10',
            endDate: '2025-11-12',
            startTime: '09:00',
            endTime: '17:00',
          },
        ],
      }));

      const result = await generateEventInfos(mockEnv, mockItem);

      expect(result).toHaveLength(2);
      expect(result[1].startTime).toBe('09:00');
      expect(result[1].endTime).toBe('17:00');
    });

    it('should use pubDate as fallback when startDate not provided', async () => {
      fetchMock.mockResolvedValueOnce(gatewayOk({
        events: [{ title: '행사', description: '설명' }],
      }));

      const result = await generateEventInfos(mockEnv, mockItem);

      expect(result[0].startDate).toBe(mockItem.pubDate);
      expect(result[0].endDate).toBe(mockItem.pubDate);
    });

    it('should throw on AI Gateway error', async () => {
      fetchMock.mockResolvedValueOnce(gatewayError());

      await expect(generateEventInfos(mockEnv, mockItem)).rejects.toThrow('AI Gateway request failed');
    });

    // Trace: AC-1 — a malformed response is a failure, not "no events"
    it('should throw AiResponseParseError on malformed JSON response', async () => {
      fetchMock.mockResolvedValueOnce(gatewayReply('invalid json'));

      await expect(generateEventInfos(mockEnv, mockItem)).rejects.toThrow(AiResponseParseError);
    });

    // Trace: AC-2 — schema violation is a failure, not "no events"
    it('should throw AiResponseParseError when events array is missing from response', async () => {
      fetchMock.mockResolvedValueOnce(gatewayOk({
        title: '단일 행사',
        description: '배열이 아닌 단일 객체',
      }));

      await expect(generateEventInfos(mockEnv, mockItem)).rejects.toThrow(AiResponseParseError);
    });

    // Trace: AC-3 — empty content means the model gave us nothing to parse
    it('should throw AiResponseParseError when the model returns empty content', async () => {
      fetchMock.mockResolvedValueOnce(gatewayReply(''));

      await expect(generateEventInfos(mockEnv, mockItem)).rejects.toThrow(AiResponseParseError);
    });

    // Trace: AC-3 — the model answered with events, but none survived validation.
    // Dropping them all is a failed extraction, not a "no events" answer.
    it('should throw AiResponseParseError when every returned event is unusable', async () => {
      fetchMock.mockResolvedValueOnce(gatewayOk({
        events: [{ title: '', description: '', startDate: '2025-11-01', endDate: '2025-11-01' }],
      }));

      await expect(generateEventInfos(mockEnv, mockItem)).rejects.toThrow(AiResponseParseError);
    });

    // Trace: AC-4 — the one genuine "no events" case must still resolve, not throw
    it('should retry an incomplete upstream response even when it contains an empty events array', async () => {
      fetchMock.mockResolvedValueOnce(gatewayReply('{"events":[]}', 'length'));

      await expect(generateEventInfos(mockEnv, mockItem)).rejects.toThrow('incomplete');
    });

    it('should reject invalid calendar dates before writing events', async () => {
      fetchMock.mockResolvedValueOnce(gatewayOk({
        events: [{ title: '행사', description: '설명', startDate: '2025-11-31', endDate: '2025-11-31' }],
      }));

      await expect(generateEventInfos(mockEnv, mockItem)).rejects.toThrow(AiResponseParseError);
    });

    it('should return empty array when AI returns empty events array', async () => {
      fetchMock.mockResolvedValueOnce(gatewayOk({ events: [] }));

      const result = await generateEventInfos(mockEnv, mockItem);
      expect(result).toHaveLength(0);
    });

    it('should call the AI Gateway with the event schema and prompt', async () => {
      fetchMock.mockResolvedValueOnce(gatewayOk({ events: [{ title: 'test', description: 'test' }] }));

      await generateEventInfos(mockEnv, mockItem);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(mockEnv.AI_GATEWAY_URL);
      expect(init.headers['cf-aig-authorization']).toBe('Bearer gateway-token');
      expect(init.headers).not.toHaveProperty('Authorization');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(init.body);
      expect(body.model).toBe(mockEnv.OPENAI_MODEL);
      expect(body.stream).toBe(false);
      expect(body.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: { strict: true, schema: { type: 'object' } },
      });
      expect(body.messages[1].content).toContain(mockItem.title);
      expect(body.messages[1].content).toContain(mockItem.pubDate);
    });

    // Double-escaping prevention tests
    describe('double-escaping prevention in descriptionHtml', () => {
      it('should not double-decode &amp;lt; in description (should stay as &lt;)', async () => {
        const itemWithDoubleEncoded: RssItem = {
          ...mockItem,
          descriptionHtml: '<p>Use &amp;lt;br&amp;gt; for breaks</p>',
        };

        fetchMock.mockResolvedValueOnce(gatewayOk({ events: [{ title: 'test', description: 'test' }] }));

        await generateEventInfos(mockEnv, itemWithDoubleEncoded);

        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        const promptContent = body.messages[1].content;

        expect(promptContent).toContain('&lt;br&gt;');
        expect(promptContent).not.toContain('<br>');
      });

      it('should decode single-level entities correctly', async () => {
        const itemWithSingleEncoded: RssItem = {
          ...mockItem,
          descriptionHtml: '<p>Date: 2025-01-01 &amp; Time: 09:00</p>',
        };

        fetchMock.mockResolvedValueOnce(gatewayOk({ events: [{ title: 'test', description: 'test' }] }));

        await generateEventInfos(mockEnv, itemWithSingleEncoded);

        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(body.messages[1].content).toContain('2025-01-01 & Time: 09:00');
      });

      it('should handle mixed single and double-encoded entities', async () => {
        const itemWithMixed: RssItem = {
          ...mockItem,
          descriptionHtml: '<p>&lt;script&gt; and &amp;amp; and &amp;lt;tag&amp;gt;</p>',
        };

        fetchMock.mockResolvedValueOnce(gatewayOk({ events: [{ title: 'test', description: 'test' }] }));

        await generateEventInfos(mockEnv, itemWithMixed);

        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        const promptContent = body.messages[1].content;

        expect(promptContent).toContain('<script>');
        expect(promptContent).toContain('&amp;');
        expect(promptContent).toContain('&lt;tag&gt;');
      });

      it('should handle numeric entities without double-decoding', async () => {
        const itemWithNumeric: RssItem = {
          ...mockItem,
          descriptionHtml: '<p>Café &#233; and &#x3A9; Omega</p>',
        };

        fetchMock.mockResolvedValueOnce(gatewayOk({ events: [{ title: 'test', description: 'test' }] }));

        await generateEventInfos(mockEnv, itemWithNumeric);

        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        const promptContent = body.messages[1].content;

        expect(promptContent).toContain('Café é');
        expect(promptContent).toContain('Ω Omega');
      });
    });
  });
});
