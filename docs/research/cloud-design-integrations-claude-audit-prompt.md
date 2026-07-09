# Cloud Design Integrations: Audit Brief and Claude Prompt

Date: 2026-07-06

## Context

Tuezday should treat design generation as a brain-first platform capability, not as a loose wrapper around third-party design tools.

The current direction:

- Prototypes are valuable for campaign-specific experiences, especially landing pages and "what to say" pages tailored to a segment, persona, or launch.
- Image generation is needed, including static backgrounds and HTML/CSS-based image generation where a template stays stable and text changes per pipeline.
- Design systems should become another tab in the Brain, alongside Soul, ICP, Voice, History, and Now.
- MCP is not a near-term requirement.
- Coding agents are not a near-term product surface because Tuezday is not running locally on client machines. API-based generation is acceptable for now, but cost must be managed.
- The architecture must be multi-tenant from the start.
- Bring-your-own-key must not break Tuezday-owned skill loading, file artifacts, design recipes, or PPTX export.
- The organizational context layer remains Tuezday Brain. Design systems become part of that context layer.

## Working Architecture Thesis

Tuezday should own:

- Workspace and campaign design context.
- Design-system memory.
- Template and artifact versioning.
- Design recipes / skills.
- Generated file storage.
- Export pipeline, including PPTX.
- Multi-tenant isolation and audit logs.
- Provider abstraction and routing.

External providers should only execute specific jobs:

- Generate or edit images.
- Convert or inspect design files.
- Render HTML/CSS to image/PDF.
- Host or edit visual canvases when useful.
- Provide optional connected design sources such as Figma, Canva, Penpot, or similar.

## Core Guardrails

1. **Brain first**
   Design System becomes a Brain document/domain, not a provider-specific config file.

2. **Provider abstraction first**
   Add a `DesignProvider` layer before deeply coupling to any API.

3. **BYOK is only credentials**
   Bring-your-own-key should authorize provider calls, but it should not own Tuezday workflows, skills, prompts, files, exports, or context.

4. **Artifacts are first-class**
   Prototypes, landing pages, HTML/CSS renders, images, PPTX exports, and design-system snapshots should be stored as tenant-scoped artifacts.

5. **Multi-tenancy is non-negotiable**
   Every design system, source file, prompt, provider credential, generated asset, export, and render job must be workspace-scoped.

6. **MCP and coding agents are later**
   MCP can be useful for power integrations later, especially with Penpot/Figma-like ecosystems, but it should not be required for the first product slice.

## Seed Integrations for Claude to Verify and Expand

These are not final recommendations. Claude should search the internet, verify current status, licensing, APIs, self-hosting options, activity, pricing, and integration fit.

- **Penpot**
  Open-source design/prototyping platform. It advertises API access through tokens, webhooks, plugins, inspect mode, and code/CSS/SVG-oriented handoff. Potential fit: design-system import/export, prototype source, open design workspace, maybe later MCP-style automation.
  Sources:
  - https://github.com/penpot/penpot
  - https://penpot.app/penpothub/plugins

- **GrapesJS**
  Open-source embeddable web builder framework for templates, landing pages, newsletters, and visual editors. Potential fit: Tuezday-owned landing page/prototype editor with our components and campaign context.
  Sources:
  - https://grapesjs.com/
  - https://github.com/GrapesJS/grapesjs

- **Webstudio**
  Open-source website builder focused on modern web standards. Potential fit: visual website/landing page builder research, though integration depth and embedding model need verification.
  Source:
  - https://webstudio.is/

- **Puck**
  MIT open-source visual editor for React. It is designed to be embedded in React/Next.js apps and use the host application's components/data. Potential fit: Tuezday-native landing page and prototype builder using our own component palette and Brain context.
  Sources:
  - https://github.com/puckeditor/puck
  - https://puckeditor.com/

- **Plasmic**
  Open-source visual builder and content platform for React/web. Potential fit: visual editing and campaign landing pages, but Claude should verify self-hosting, licensing, operational complexity, and whether it is too much product surface for the first slice.
  Sources:
  - https://github.com/plasmicapp/plasmic
  - https://www.plasmic.app/

- **tldraw**
  Infinite canvas SDK for React with customization and collaboration primitives. Potential fit: visual campaign boards, prototype sketching, creative planning canvases. Probably not the first landing-page generator, but worth evaluating.
  Sources:
  - https://tldraw.dev/
  - https://github.com/tldraw/tldraw

- **Builder.io / Visual Copilot**
  Commercial design-to-code and visual development ecosystem. Potential fit: API-based design-to-code benchmark or optional provider, but likely not an open-source foundation. Claude should compare it as a commercial alternative, not assume it should be core.
  Source:
  - https://www.builder.io/m/design-to-code

- **Figma / Canva**
  Important commercial integration candidates for import/export and customer workflow compatibility. Claude should evaluate their APIs, export limitations, cost, and lock-in risk, but avoid making them core to Tuezday's design memory.

- **Excalidraw, Fabric.js, Konva, Remotion, Satori, Playwright, Sharp**
  Claude should verify whether these or similar libraries are useful for specific rendering/canvas/image/PPTX pipelines. These are likely lower-level building blocks rather than product integrations.

## Prompt to Give Claude

You are auditing Tuezday's proposed cloud design integration architecture.

Tuezday is an AI-powered GTM orchestration platform with a central Brain. The Brain currently contains organizational context such as Soul, ICP, Voice, History, and Now. We want to add a design layer so campaigns can generate customized prototypes, landing pages, static images, HTML/CSS renders, and presentation exports.

Current product direction:

1. Prototypes should be useful for different campaign types. A campaign should be able to generate customized landing pages or "what to say" pages for different ICPs, personas, segments, and launch contexts.
2. Image generation is needed. This includes AI image generation and deterministic HTML/CSS-based image generation, such as static backgrounds with variable text.
3. Design systems should become another Brain tab or Brain domain. Tuezday's organizational context layer remains our Brain, and design-system context becomes part of it.
4. MCP is not a priority right now.
5. Coding agents are not a near-term product feature because Tuezday will not run locally on client machines. API-based generation is acceptable for now, but we need a path to lower cost later.
6. Multi-tenancy must be designed from the start.
7. Bring-your-own-key should be supported, but BYOK must not cause us to lose Tuezday-owned skill loading, file-system artifacts, design recipe storage, artifact versioning, or PPTX export.

Audit this plan deeply.

Your tasks:

1. Search the internet for current design, prototyping, visual-editor, design-to-code, HTML/CSS rendering, image generation, and open-source website-builder options we could integrate into Tuezday.
2. Specifically look for open-source projects similar to "Open Design" or open design platforms that can be embedded, self-hosted, API-driven, or used as architectural foundations.
3. Review at least these candidates:
   - Penpot
   - GrapesJS
   - Webstudio
   - Puck
   - Plasmic
   - tldraw
   - Excalidraw
   - Figma APIs / Dev Mode / MCP if relevant
   - Canva APIs if relevant
   - Builder.io / Visual Copilot as a commercial benchmark
   - Any newer or better options you find
4. For each candidate, evaluate:
   - What it does
   - License and commercial usability
   - Self-hosting feasibility
   - API/plugin/export capabilities
   - Whether it can be embedded inside a SaaS platform
   - Whether it supports multi-tenant isolation
   - Whether it helps with prototypes, landing pages, image generation, HTML/CSS rendering, design systems, or PPTX exports
   - Operational complexity
   - Cost model
   - Lock-in risk
   - Recommended role in Tuezday: core foundation, optional provider, import/export connector, internal tool, or reject

5. Propose a revised architecture that preserves these principles:
   - Tuezday Brain is the source of organizational/design context.
   - Design System is a Brain domain.
   - Tuezday owns artifacts, design recipes/skills, prompts, generated files, exports, and versioning.
   - Providers are execution engines, not the source of truth.
   - BYOK only supplies credentials and quota. It does not own workflows.
   - Tenant isolation applies to prompts, files, keys, renders, exports, and job logs.

6. Propose the data model:
   - Design system records
   - Campaign design briefs
   - Design artifacts
   - Prototype/page artifacts
   - Image template artifacts
   - Provider credentials
   - Render/export jobs
   - Version history
   - Audit logs

7. Propose the service architecture:
   - Design Brain service
   - DesignProvider abstraction
   - Render worker
   - Artifact store
   - Export pipeline
   - BYOK credential vault
   - Design recipe/skill loader
   - Multi-tenant job queue

8. Propose the first implementation slice for Tuezday:
   - Design System Brain tab
   - One campaign design brief flow
   - One HTML/CSS prototype generator
   - One deterministic HTML/CSS-to-image renderer
   - One provider-backed image generation integration
   - One PPTX export path

9. Identify risks and tradeoffs:
   - API cost
   - provider lock-in
   - tenant data leakage
   - prompt/artifact leakage
   - rendering sandbox security
   - inconsistent design quality
   - file storage growth
   - whether visual editors are too large for the first slice

10. Generate a detailed implementation plan:
   - Milestones
   - Backend services
   - Frontend screens
   - Database changes
   - Provider interfaces
   - Worker/job architecture
   - File storage
   - Security controls
   - Testing strategy
   - Rollout plan
   - Cost controls

Output format:

1. Executive recommendation
2. Integration landscape with citations
3. Candidate comparison table
4. Recommended architecture
5. Multi-tenancy and BYOK model
6. Data model
7. Implementation plan by phase
8. Testing and security plan
9. Open questions
10. Final recommendation: what to build first, what to defer, what to reject

Be direct. Challenge assumptions where necessary. Do not assume that every design tool should be integrated. Prefer a focused architecture that lets Tuezday generate useful campaign design artifacts quickly while keeping Brain, artifacts, skills, and exports under our control.

## Expected Claude Deliverable

Claude should produce a research-backed implementation plan, not just a brainstorming memo. The plan should be specific enough to turn into Tuezday specs and engineering tasks.

The output should make clear:

- Which integrations are useful now.
- Which are useful later.
- Which are distractions.
- Whether Penpot, GrapesJS, Puck, Webstudio, Plasmic, or another open-source project should be the foundation.
- How Tuezday preserves its own Brain, skill loading, artifacts, and exports even when using BYOK provider calls.
- How to design this for multi-tenant SaaS from day one.

