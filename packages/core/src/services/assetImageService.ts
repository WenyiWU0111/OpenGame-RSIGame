/**
 * Image Generation Service
 * Supports Tongyi and Doubao models
 * Inspired by PiXelDa's model architecture
 */

import { BaseService } from './assetBaseService.js';
import type { ImageModelConfig } from '../tools/generate-assets-types.js';

// ============== Tongyi Image Service ==============

export class TongyiImageService extends BaseService {
  private config: ImageModelConfig;

  constructor(config: ImageModelConfig) {
    super();
    this.config = config;
  }

  private isAsyncModel(modelName: string): boolean {
    return modelName.includes('wan') && modelName.includes('t2i');
  }

  async generateImage(
    prompt: string,
    size: string = '1024*1024',
    _referenceImageUrl?: string | null,
  ): Promise<string> {
    // Tongyi's t2i endpoints take no reference image; style-anchor
    // conditioning is a doubao-only capability for now (prompt text still
    // carries the style_anchor string).
    this.log(`Generating image with Tongyi: ${prompt.substring(0, 50)}...`);

    const modelName = this.config.modelNameGeneration;

    if (this.isAsyncModel(modelName)) {
      return this.generateImageAsync(prompt, size);
    } else {
      return this.generateImageSync(prompt, size);
    }
  }

  private async generateImageAsync(
    prompt: string,
    size: string,
  ): Promise<string> {
    const url = `${this.config.baseUrl}/api/v1/services/aigc/text2image/image-synthesis`;

    const payload = {
      model: this.config.modelNameGeneration,
      input: {
        prompt,
        negative_prompt: '',
      },
      parameters: {
        prompt_extend: false,
        size,
        n: 1,
      },
    };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Tongyi Image API failed: ${response.status} - ${errorBody}`,
      );
    }

    const taskData = (await response.json()) as {
      output?: { task_id?: string };
    };
    const taskId = taskData.output?.task_id;
    if (!taskId) {
      throw new Error('Tongyi text2image returned no task ID');
    }

    this.log(`Created async task: ${taskId}`);

    const taskUrl = `${this.config.baseUrl}/api/v1/tasks/${taskId}`;
    const result = await this.pollTaskStatus(taskUrl, {
      Authorization: `Bearer ${this.config.apiKey}`,
    });

    const resultUrl = result.output?.results?.[0]?.url;
    if (!resultUrl) {
      throw new Error('Tongyi text2image task completed but no URL returned');
    }

    this.log(`Image generated successfully`);
    return resultUrl;
  }

  private async generateImageSync(
    prompt: string,
    size: string,
  ): Promise<string> {
    const url = `${this.config.baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;

    const payload = {
      model: this.config.modelNameGeneration,
      input: {
        messages: [
          {
            role: 'user',
            content: [{ text: prompt }],
          },
        ],
      },
      parameters: {
        prompt_extend: false,
        size,
      },
    };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Tongyi Image API failed: ${response.status} - ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      output?: {
        choices?: Array<{
          message?: { content?: Array<{ image?: string }> | unknown };
        }>;
      };
    };
    const choices = data.output?.choices;
    if (!choices || choices.length === 0) {
      throw new Error('Tongyi returned no choices');
    }

    const content = choices[0].message?.content;
    if (!content || !Array.isArray(content)) {
      throw new Error('Tongyi content format error');
    }

    const imageItem = content.find((item: { image?: string }) => item.image);
    if (!imageItem || !imageItem.image) {
      throw new Error('Tongyi response missing image URL');
    }

    this.log(`Image generated successfully`);
    return imageItem.image;
  }

  private isWanxEditModel(modelName: string): boolean {
    return modelName.includes('wanx') && modelName.includes('imageedit');
  }

  async editImage(
    referenceImageUrl: string,
    prompt: string,
    previousFrameUrl?: string | null,
  ): Promise<string> {
    this.log(`Editing image with Tongyi I2I...`);

    const modelName = this.config.modelNameEditing;

    if (this.isWanxEditModel(modelName)) {
      return this.editImageWanx(referenceImageUrl, prompt);
    } else {
      return this.editImageI2I(referenceImageUrl, prompt, previousFrameUrl);
    }
  }

  private async editImageWanx(
    referenceImageUrl: string,
    prompt: string,
  ): Promise<string> {
    const url = `${this.config.baseUrl}/api/v1/services/aigc/text2image/image-synthesis`;

    // Convert URL to Base64 to avoid "url error" issues with cross-region OSS
    const base64Image = await this.imageUrlToBase64(referenceImageUrl);

    const payload = {
      model: this.config.modelNameEditing,
      input: {
        prompt,
        negative_prompt: '',
        function: 'description_edit',
        base_image_url: base64Image,
      },
      parameters: {
        prompt_extend: false,
        n: 1,
        size: '1024*1024',
      },
    };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Tongyi wanx edit API failed: ${response.status} - ${errorBody}`,
      );
    }

    const taskData = (await response.json()) as {
      output?: { task_id?: string };
    };
    const taskId = taskData.output?.task_id;
    if (!taskId) {
      throw new Error('Tongyi wanx edit returned no task ID');
    }

    this.log(`Created wanx edit task: ${taskId}`);

    const taskUrl = `${this.config.baseUrl}/api/v1/tasks/${taskId}`;
    const result = await this.pollTaskStatus(taskUrl, {
      Authorization: `Bearer ${this.config.apiKey}`,
    });

    const resultUrl = result.output?.results?.[0]?.url;
    if (!resultUrl) {
      throw new Error('Tongyi wanx edit task completed but no URL returned');
    }

    this.log(`Image editing completed`);
    return resultUrl;
  }

  private async editImageI2I(
    referenceImageUrl: string,
    prompt: string,
    previousFrameUrl?: string | null,
  ): Promise<string> {
    const url = `${this.config.baseUrl}/api/v1/services/aigc/image2image/image-synthesis`;

    const images = previousFrameUrl
      ? [referenceImageUrl, previousFrameUrl]
      : [referenceImageUrl];

    const payload = {
      model: this.config.modelNameEditing,
      input: {
        prompt,
        images,
      },
      parameters: {
        prompt_extend: false,
        n: 1,
      },
    };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Tongyi I2I API failed: ${response.status} - ${errorBody}`,
      );
    }

    const taskData = (await response.json()) as {
      output?: { task_id?: string };
    };
    const taskId = taskData.output?.task_id;
    if (!taskId) {
      throw new Error('Tongyi I2I returned no task ID');
    }

    const taskUrl = `${this.config.baseUrl}/api/v1/tasks/${taskId}`;
    const result = await this.pollTaskStatus(taskUrl, {
      Authorization: `Bearer ${this.config.apiKey}`,
    });

    const resultUrl = result.output?.results?.[0]?.url;
    if (!resultUrl) {
      throw new Error('Tongyi I2I task completed but no URL returned');
    }

    this.log(`Image editing completed`);
    return resultUrl;
  }

  private async imageUrlToBase64(imageUrl: string): Promise<string> {
    this.log(
      `Downloading image for Base64 conversion: ${imageUrl.substring(0, 50)}...`,
    );

    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    const contentType = response.headers.get('content-type') || 'image/png';
    return `data:${contentType};base64,${base64}`;
  }
}

// ============== Doubao Image Service ==============

export class DoubaoImageService extends BaseService {
  private config: ImageModelConfig;
  private arkBaseUrl: string;

  constructor(config: ImageModelConfig) {
    super();
    this.config = config;
    // Allow the user to override the Volcengine ARK base URL (e.g. for
    // a regional endpoint or a self-hosted proxy). Falls back to the
    // public Beijing endpoint that ships with the original implementation.
    this.arkBaseUrl =
      config.baseUrl && config.baseUrl.length > 0
        ? config.baseUrl
        : 'https://ark.cn-beijing.volces.com/api/v3';
  }

  /**
   * Minimum output size the image gateway accepts for image-CONDITIONED
   * generations (i2i). Verified empirically on one OpenAI-compatible image gateway:
   * `/images/edits` returns HTTP 200 with an EMPTY body, while
   * `/images/generations` with an `image` param succeeds — but only when
   * the requested output area is >= ~3.79MP (2048x2048 = 4.19MP clears
   * the bar; 1024x1024 does not).
   */
  private static readonly I2I_MIN_SIZE = '2048x2048';
  private static readonly I2I_MIN_PIXELS = 3_786_400;

  private i2iSize(size: string): string {
    const normalized = size.replace('*', 'x');
    const [w, h] = normalized.split('x').map((n) => parseInt(n, 10));
    if (!w || !h || w * h < DoubaoImageService.I2I_MIN_PIXELS) {
      return DoubaoImageService.I2I_MIN_SIZE;
    }
    return normalized;
  }

  /**
   * Shared POST to /images/generations with defensive body parsing. The
   * gateway occasionally returns HTTP 200 with an empty body; parsing that
   * with response.json() used to surface as a bare SyntaxError, which the
   * animation frame-retry logic classified as non-retriable and aborted
   * the whole asset. Classify it as a transient server error instead.
   */
  private async requestImagesGenerations(
    payload: object,
    label: string,
  ): Promise<string> {
    const url = `${this.arkBaseUrl}/images/generations`;
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Doubao ${label} API failed: ${response.status} - ${errorBody}`,
      );
    }

    const raw = await response.text();
    if (!raw || raw.trim().length === 0) {
      throw new Error(
        `Doubao ${label} gateway returned an empty 200 body (transient server error)`,
      );
    }
    let data: { data?: Array<{ url?: string }> };
    try {
      data = JSON.parse(raw) as { data?: Array<{ url?: string }> };
    } catch {
      throw new Error(
        `Doubao ${label} returned an unparsable body (transient server error): ` +
          raw.slice(0, 120),
      );
    }

    if (!data.data || data.data.length === 0) {
      throw new Error(`Doubao ${label} returned no results`);
    }
    const resultUrl = data.data[0].url;
    if (!resultUrl) {
      throw new Error(`Doubao ${label} returned a result without a URL`);
    }
    return resultUrl;
  }

  async generateImage(
    prompt: string,
    size: string = '1024x1024',
    referenceImageUrl?: string | null,
  ): Promise<string> {
    if (referenceImageUrl) {
      // Style-referenced generation: condition on the reference image via
      // the generations+image path (the working i2i route on this gateway).
      // Uses the editing model id — on that gateway only
      // that endpoint accepts an `image` param.
      this.log(
        `Generating image with Doubao (style-referenced): ${prompt.substring(0, 50)}...`,
      );
      const resultUrl = await this.requestImagesGenerations(
        {
          model:
            this.config.modelNameEditing || this.config.modelNameGeneration,
          prompt,
          image: referenceImageUrl,
          size: this.i2iSize(size),
          watermark: false,
        },
        'referenced-generation',
      );
      this.log(`Image generated successfully`);
      return resultUrl;
    }

    this.log(`Generating image with Doubao: ${prompt.substring(0, 50)}...`);
    const resultUrl = await this.requestImagesGenerations(
      {
        model: this.config.modelNameGeneration,
        prompt,
        size: size.replace('*', 'x'),
        watermark: false,
      },
      'generation',
    );
    this.log(`Image generated successfully`);
    return resultUrl;
  }

  async editImage(
    imageUrl: string,
    prompt: string,
    previousFrameUrl?: string | null,
  ): Promise<string> {
    // `/images/edits` is broken on that gateway (HTTP 200, empty
    // body — see requestImagesGenerations). Route edits through the
    // verified generations+image i2i path instead. For animation frame
    // chains, condition on the PREVIOUS frame when available so motion
    // stays coherent frame-to-frame; the base reference anchors frame 1.
    this.log(`Editing image with Doubao (via generations+image)...`);
    const conditioningUrl = previousFrameUrl || imageUrl;
    const resultUrl = await this.requestImagesGenerations(
      {
        model: this.config.modelNameEditing || this.config.modelNameGeneration,
        prompt,
        image: conditioningUrl,
        size: DoubaoImageService.I2I_MIN_SIZE,
        watermark: false,
      },
      'edit',
    );
    this.log(`Image editing completed`);
    return resultUrl;
  }
}

// ============== OpenAI-Compatible Image Service ==============
//
// Talks to any endpoint that implements the OpenAI Images REST shape:
//   POST {baseUrl}/images/generations  { model, prompt, size, n }
//   POST {baseUrl}/images/edits        (multipart) { model, prompt, image }
//
// This covers the official OpenAI API (DALL-E / gpt-image-1), Stability
// proxies, fal.ai's OpenAI shim, OpenRouter image routes, Together.ai's
// image endpoints, etc. Sizes are passed through as-is (callers should
// use that provider's native vocabulary, e.g. "1024x1024").

/**
 * Some image models refuse a request below a minimum output area, and the
 * generic OpenAI-images default of 1024x1024 is below several of them.
 * Measured on OpenRouter's `bytedance-seed/seedream-5-0-lite`:
 *
 *   400 — requires at least 3,686,400 output pixels; size "1024x1024" is
 *         1,048,576. Use a larger size such as "2048x2048".
 *
 * That is not a transient error, so `generateImageWithRetry` does not retry
 * it: EVERY sprite call fails, immediately, and the run looks like a broken
 * endpoint rather than a size that one provider will not serve. The sprite
 * path passes `req.size || '1024*1024'`, so nothing upstream would have
 * raised it.
 *
 * Kept as a floor on AREA rather than a fixed size, and driven by env rather
 * than a table of model names: the aspect ratio the caller asked for is a
 * deliberate choice (a 7x7 tile atlas is square, a banner is not) and must
 * survive. Unset means unset — providers with no such minimum are untouched.
 */
export function raiseToMinPixels(
  size: string,
  minPixels: number = Number(process.env['OPENGAME_IMAGE_MIN_PIXELS'] ?? 0),
): string {
  const m = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!m || !Number.isFinite(minPixels) || minPixels <= 0) return size;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w * h >= minPixels) return size;
  // Scale both axes by the same factor, so the requested aspect ratio holds,
  // then round UP to a multiple of 64 -- rounding down could land back under
  // the floor and re-earn the same 400.
  const k = Math.sqrt(minPixels / (w * h));
  const up = (n: number) => Math.ceil((n * k) / 64) * 64;
  return `${up(w)}x${up(h)}`;
}

/**
 * The real container, read off the first bytes of the base64 payload. A data
 * URL that says png while carrying jpeg bytes survives a browser (they sniff)
 * and then loses to anything that trusts the label.
 */
export function sniffImageMime(b64: string): string {
  const head = b64.slice(0, 16);
  if (head.startsWith('iVBORw0KGgo')) return 'image/png';
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  if (head.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

export class OpenAICompatImageService extends BaseService {
  private config: ImageModelConfig;

  constructor(config: ImageModelConfig) {
    super();
    this.config = config;
  }

  async generateImage(
    prompt: string,
    size: string = '1024x1024',
    referenceImageUrl?: string | null,
  ): Promise<string> {
    this.log(
      `Generating image via OpenAI-compat: ${prompt.substring(0, 50)}...`,
    );
    if (referenceImageUrl) {
      // No image-conditioned generation on the generic OpenAI images shape
      // (edits is multipart and provider-dependent) — degrade to a textual
      // style hint so anchored calls still bias toward consistency.
      prompt = `${prompt} (matching the established reference style)`;
    }

    const url = `${this.config.baseUrl}/images/generations`;
    const normalizedSize = raiseToMinPixels(size.replace('*', 'x'));

    const payload = {
      model: this.config.modelNameGeneration,
      prompt,
      size: normalizedSize,
      n: 1,
      response_format: 'url',
    };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `OpenAI-compat image API failed: ${response.status} - ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      data?: Array<{ url?: string; b64_json?: string }>;
    };
    const item = data.data?.[0];
    if (!item) {
      throw new Error('OpenAI-compat image API returned no results');
    }

    if (item.url) {
      return item.url;
    }
    if (item.b64_json) {
      // Surface base64 results as a data URL so downstream code can consume
      // them with the same `fetch(url)` it uses for hosted images.
      //
      // The mime is SNIFFED, not assumed. It was hardcoded to image/png, and
      // seedream-5-0-lite returns JPEG: every generated asset then travelled
      // as a data URL whose declared type contradicted its own bytes.
      return `data:${sniffImageMime(item.b64_json)};base64,${item.b64_json}`;
    }

    throw new Error(
      'OpenAI-compat image API returned neither url nor b64_json',
    );
  }

  async editImage(
    referenceImageUrl: string,
    prompt: string,
    _previousFrameUrl?: string | null,
  ): Promise<string> {
    // The OpenAI image-edit endpoint only takes a single reference image
    // and uses multipart/form-data, which adds non-trivial complexity.
    // For now we fall back to a fresh generation that includes the prompt
    // — most callers (e.g. animation frames) only need style consistency
    // via the prompt rather than a true image-conditioned edit. Users who
    // need real I2I should select a Tongyi or Doubao provider for image.
    this.log(
      'OpenAI-compat editImage falls back to plain text-to-image; use tongyi/doubao for true I2I.',
      'warn',
    );
    return this.generateImage(`${prompt} (matching reference style)`);
  }
}

// ============== Image Service Interface ==============

export interface IImageService {
  /**
   * `referenceImageUrl` (optional): a style-anchor image to condition the
   * generation on. Providers with a working i2i path (doubao) honor it;
   * others fall back to prompt-only generation and may append a textual
   * style hint instead.
   */
  generateImage(
    prompt: string,
    size?: string,
    referenceImageUrl?: string | null,
  ): Promise<string>;
  editImage(
    referenceImageUrl: string,
    prompt: string,
    previousFrameUrl?: string | null,
  ): Promise<string>;
}

// ============== Factory ==============

export function createImageService(config: ImageModelConfig): IImageService {
  switch (config.modelType) {
    case 'doubao':
      return new DoubaoImageService(config);
    case 'openai-compat':
      return new OpenAICompatImageService(config);
    case 'tongyi':
    default:
      return new TongyiImageService(config);
  }
}
