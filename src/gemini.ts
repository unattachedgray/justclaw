/**
 * Google Gemini API integration — image gen/edit, PDF analysis, vision, grounded search.
 *
 * Models:
 *   - gemini-3.1-flash-image-preview: image generation and editing
 *   - gemini-2.5-flash: text, PDF, vision, structured output, search grounding
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { getLogger } from './logger.js';

const log = getLogger('gemini');

const IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const TEXT_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) throw new Error('GEMINI_API_KEY not set in environment');
  return key;
}

function outputDir(subdir: string): string {
  const dir = join(process.env.JUSTCLAW_ROOT || process.cwd(), 'data', subdir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- Shared types and helpers ---

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    groundingMetadata?: { groundingChunks?: Array<{ web?: { uri: string; title: string } }> };
  }>;
  error?: { message: string; code?: number };
}

/** Call the Gemini generateContent API. */
async function callGemini(
  model: string,
  parts: GeminiPart[],
  config?: Record<string, unknown>,
  tools?: unknown[],
): Promise<GeminiResponse> {
  const url = `${API_BASE}/${model}:generateContent?key=${getApiKey()}`;

  const body: Record<string, unknown> = {
    contents: [{ parts }],
  };
  if (config) body.generationConfig = config;
  if (tools) body.tools = tools;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini ${model} error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await resp.json()) as GeminiResponse;
  if (data.error) throw new Error(`Gemini error: ${data.error.message}`);
  return data;
}

/** Extract text and optional image from Gemini response. */
function extractResponse(data: GeminiResponse): { text: string; imageData: { mimeType: string; data: string } | null } {
  const parts = data.candidates?.[0]?.content?.parts || [];
  let text = '';
  let imageData: { mimeType: string; data: string } | null = null;
  for (const p of parts) {
    if (p.text) text += p.text;
    if (p.inlineData) imageData = p.inlineData;
  }
  return { text, imageData };
}

/** Save image data to disk, return path. */
function saveImage(imageData: { mimeType: string; data: string }, prefix: string): string {
  const ext = imageData.mimeType.includes('png') ? 'png' : 'jpg';
  const filename = `${prefix}-${Date.now()}.${ext}`;
  const path = join(outputDir('images'), filename);
  writeFileSync(path, Buffer.from(imageData.data, 'base64'));
  return path;
}

/** Read a file as base64 with mime type detection. */
function readFileAsBase64(filePath: string): { mimeType: string; data: string } {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const data = readFileSync(filePath).toString('base64');
  const ext = filePath.toLowerCase().split('.').pop() || '';
  const mimeMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp3: 'audio/mp3', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  };
  return { mimeType: mimeMap[ext] || 'application/octet-stream', data };
}

/** Extract grounding sources from response. */
function extractSources(data: GeminiResponse): string[] {
  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return chunks
    .filter((c) => c.web?.uri)
    .map((c) => `[${c.web!.title || 'Source'}](${c.web!.uri})`);
}

// --- Tool registration ---

export function registerGeminiTools(server: McpServer): void {
  registerImageGenerate(server);
  registerImageEdit(server);
  registerPdfAnalyze(server);
  registerVisionAnalyze(server);
  registerGeminiSearch(server);
}

function registerImageGenerate(server: McpServer): void {
  server.tool(
    'image_generate',
    `Generate a photorealistic or artistic image using Gemini AI.
**When to use:** Photos, illustrations, art, realistic infographics — anything that needs raster imagery.
**Do NOT use for:** Diagrams, flowcharts, or data charts — generate those as SVG, Mermaid, or HTML instead (free, higher quality for structured visuals).
**Returns:** File path to the generated image for Discord attachment.`,
    {
      prompt: z.string().describe('Detailed image description. Be specific about style, content, colors, layout.'),
    },
    async ({ prompt }) => {
      try {
        const data = await callGemini(IMAGE_MODEL, [{ text: prompt }], {
          responseModalities: ['TEXT', 'IMAGE'],
        });
        const { text, imageData } = extractResponse(data);
        if (!imageData) throw new Error('No image returned: ' + text.slice(0, 200));
        const imagePath = saveImage(imageData, 'gemini');
        log.info('Image generated', { prompt: prompt.slice(0, 80), path: imagePath });
        return { content: [{ type: 'text', text: JSON.stringify({ image_path: imagePath, description: text || 'Image generated' }, null, 2) }] };
      } catch (err) {
        log.error('Image generation failed', { error: String(err) });
        return { content: [{ type: 'text', text: `Image generation failed: ${err}` }], isError: true };
      }
    },
  );
}

function registerImageEdit(server: McpServer): void {
  server.tool(
    'image_edit',
    `Edit an existing image using Gemini AI. Send the image + edit instructions.
**When to use:** Modify a previously generated image, change colors, add/remove elements, adjust proportions.
**Supports:** PNG, JPG, WEBP. Send the file path of the image to edit.`,
    {
      image_path: z.string().describe('Path to the image file to edit'),
      edit_prompt: z.string().describe('What to change: "make the waist slimmer", "remove background", "add sunset"'),
    },
    async ({ image_path, edit_prompt }) => {
      try {
        const imgData = readFileAsBase64(image_path);
        const data = await callGemini(IMAGE_MODEL, [
          { text: edit_prompt },
          { inlineData: imgData },
        ], { responseModalities: ['TEXT', 'IMAGE'] });
        const { text, imageData } = extractResponse(data);
        if (!imageData) throw new Error('No edited image returned: ' + text.slice(0, 200));
        const editedPath = saveImage(imageData, 'edited');
        log.info('Image edited', { edit: edit_prompt.slice(0, 80), path: editedPath });
        return { content: [{ type: 'text', text: JSON.stringify({ image_path: editedPath, original: image_path, description: text || 'Image edited' }, null, 2) }] };
      } catch (err) {
        log.error('Image edit failed', { error: String(err) });
        return { content: [{ type: 'text', text: `Image edit failed: ${err}` }], isError: true };
      }
    },
  );
}

function registerPdfAnalyze(server: McpServer): void {
  server.tool(
    'pdf_analyze',
    `Analyze a PDF using Gemini AI vision — understands charts, tables, diagrams, and visual layout.
**When to use:** ONLY when the PDF has charts, graphs, diagrams, or complex visual layouts that matter.
**Do NOT use for:** Plain text PDFs — use the Read tool instead, which reads PDFs natively and is free.
**Supports:** Up to 50MB, 1000 pages.`,
    {
      pdf_path: z.string().describe('Path to the PDF file'),
      question: z.string().describe('What to analyze: "summarize", "extract all tables as JSON", "what are the key findings?"'),
    },
    async ({ pdf_path, question }) => {
      try {
        const pdfData = readFileAsBase64(pdf_path);
        if (pdfData.mimeType !== 'application/pdf') throw new Error('File is not a PDF');
        const data = await callGemini(TEXT_MODEL, [
          { text: question },
          { inlineData: pdfData },
        ]);
        const { text } = extractResponse(data);
        log.info('PDF analyzed', { file: basename(pdf_path), question: question.slice(0, 80) });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        log.error('PDF analysis failed', { error: String(err) });
        return { content: [{ type: 'text', text: `PDF analysis failed: ${err}` }], isError: true };
      }
    },
  );
}

function registerVisionAnalyze(server: McpServer): void {
  server.tool(
    'vision_analyze',
    `Analyze an image using Gemini AI vision — OCR, chart reading, UI analysis, object detection.
**When to use:** ONLY when Claude's native vision (Read tool on images) is insufficient — e.g., you need
bounding box coordinates, structured JSON extraction from complex UIs, or batch image processing.
**Do NOT use for:** Simple image description or reading text — use the Read tool, which has built-in vision.
**Supports:** PNG, JPG, WEBP, GIF, SVG.`,
    {
      image_path: z.string().describe('Path to the image file'),
      question: z.string().default('Describe this image in detail').describe('What to analyze: "extract all text", "what does this chart show?", "describe the UI elements"'),
    },
    async ({ image_path, question }) => {
      try {
        const imgData = readFileAsBase64(image_path);
        const data = await callGemini(TEXT_MODEL, [
          { text: question },
          { inlineData: imgData },
        ]);
        const { text } = extractResponse(data);
        log.info('Vision analysis', { file: basename(image_path), question: question.slice(0, 80) });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        log.error('Vision analysis failed', { error: String(err) });
        return { content: [{ type: 'text', text: `Vision analysis failed: ${err}` }], isError: true };
      }
    },
  );
}

function registerGeminiSearch(server: McpServer): void {
  server.tool(
    'gemini_search',
    `Search the web using Gemini with Google Search grounding. Returns a synthesized answer with source citations.
**When to use:** ONLY when you need a grounded answer with inline source citations from Google.
**Do NOT use for:** General web searches — use WebSearch first, which is built-in and doesn't cost API calls.
**Advantage:** Synthesized answer with cited sources, not raw search results. Best for fact-checking.`,
    {
      query: z.string().describe('The question or topic to research'),
    },
    async ({ query }) => {
      try {
        const data = await callGemini(TEXT_MODEL, [{ text: query }], undefined, [
          { google_search: {} },
        ]);
        const { text } = extractResponse(data);
        const sources = extractSources(data);
        const result = sources.length > 0
          ? `${text}\n\n**Sources:**\n${sources.join('\n')}`
          : text;
        log.info('Gemini search', { query: query.slice(0, 80), sources: sources.length });
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        log.error('Gemini search failed', { error: String(err) });
        return { content: [{ type: 'text', text: `Gemini search failed: ${err}` }], isError: true };
      }
    },
  );
}
