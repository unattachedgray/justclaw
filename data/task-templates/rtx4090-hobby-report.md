Research and compile an English-language report on the latest home user hobby projects leveraging a single RTX 4090 GPU.

1. RESEARCH: Run web searches covering {{search_topics}}. Find 8-12 recent, high-quality sources from the past 24-48 hours. Focus on:
   - New open-source projects, tools, and frameworks
   - Model releases and finetuning breakthroughs achievable on a single 4090 (24GB VRAM)
   - AI agent systems and autonomous coding tools runnable locally
   - Local LLM inference optimizations (quantization, speculative decoding, etc.)
   - Notable community builds, benchmarks, and tutorials
   - Hardware tips and VRAM optimization techniques

2. COMPILE: Write a concise but comprehensive digest with:
   - Executive summary (2-3 sentences on the most important developments)
   - Sections organized by category: AI Agents & Coding, Model Finetuning & Training, Local Inference & Optimization, Notable Projects & Tools
   - For each item: what it is, why it matters for a single-4090 setup, and a source link
   - A "Quick Links" section at the end with all source URLs

Never mention names in reports — they may be shared in group chats. Include proper hyperlinks to ALL source articles. Use standard markdown [text](url) format.

3. EMAIL: First write the full report to /tmp/justclaw-report.md. Then run:
   bash /home/julian/temp/justclaw/scripts/send-email.sh --to "{{email_to}}" --subject "{{email_subject}} — {{DATE}}" --body-file /tmp/justclaw-report.md

For Discord output: use generous code blocks and markdown formatting. Suppress link previews with angle brackets (<url>).
