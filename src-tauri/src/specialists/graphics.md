Graphics checklist. These are the ways GPU and canvas code has failed on real devices: memory that was never freed until an iPad lost its WebGL context, a texture uploaded larger than the device allows, a render loop that kept drawing an idle page, a shader whose result depended on the GPU, and colours that shifted through repeated conversions. Check each with the weakest supported device in mind, usually an iPad.

GPU memory and disposal:
- Every geometry, material, texture, render target, and renderer that is created gets a `dispose()` once it's no longer used, including when a prop change replaces it. Frameworks dispose only what they created declaratively. Objects passed in as primitives, created imperatively, or cached are yours to free.
- A temporary renderer or canvas context is released explicitly, with `dispose()` and `forceContextLoss()`. Browsers limit live WebGL contexts per page and drop the oldest first, which is often the main canvas.
- Replacing a buffer attribute (instance matrices, a vertex array) leaks the old GPU buffer unless it is disposed.
- Caches of textures or render targets need a budget and eviction. An unbounded cache is a slow leak.
- Estimate texture memory: width × height × 4 bytes, plus a third for mipmaps, on the GPU, and often again on the CPU. Upscaling small images to a fixed size multiplies it.
- A closed `ImageBitmap` can't be uploaded again. Check the order of closing and uploading.

Device limits and context loss:
- Textures and render targets fit within `MAX_TEXTURE_SIZE` and the device's memory. Some libraries downscale an oversized texture silently, which shows as blur rather than an error.
- Context loss is handled: `webglcontextlost` and `webglcontextrestored` listeners, and `isContextLost()` checked before reading pixels back.
- Every extra canvas and renderer costs a context and memory. Prefer one renderer with scissoring or render targets over many canvases.
- Antialiasing, high pixel ratios, shadows, and post-processing multiply the cost. Cap the pixel ratio, especially on mobile.

Render loop:
- With on-demand rendering, a change made outside the framework's state (mutating an object, a uniform, or a camera) needs an explicit invalidate, or nothing redraws.
- A frame that unconditionally invalidates the next, or a comparison that never settles (`NaN !== NaN`, floating-point drift), renders forever while the page sits idle.
- Per-frame callbacks run in a defined order. Code that reads the camera or a transform runs after whatever writes it, or it lags a frame behind.
- Stopping the render loop doesn't stop the DOM listeners and animations that feed it.

Per-frame cost:
- No allocations in the render loop or in pointer handlers: reuse vectors, matrices, and arrays.
- No scene-wide searches (`traverse`, `getObjectByName`) every frame.
- Reading pixels back from the GPU (`readPixels`, `toDataURL`, `getImageData` on a WebGL canvas) stalls the pipeline. Do it rarely, and asynchronously where possible.
- Shaders compile once. Changing defines or creating materials per frame recompiles them.
- Raycasting tests every object with handlers on every pointer move, so keep that set small.
- Large assets (videos, models, big images) load and decode lazily, and off the main thread where possible.

Textures, filtering, and mipmaps:
- Turning mipmaps off requires `minFilter` set to linear or nearest, or the texture renders black.
- Data textures default to nearest filtering. Check which filtering each texture needs.
- Generate mipmaps once, after the final write, not on every pass.
- Render targets that grow but never shrink keep old content at their edges. Clear them, or size them exactly.

Colour, alpha, and precision:
- Know the colour space of every texture and output: colour textures in sRGB, data textures (normals, masks, IDs) linear, and the renderer's output. A mismatch looks washed out or too dark.
- Converting between premultiplied and straight alpha loses precision every time. Convert once, and blend the way the textures are stored.
- `mediump` floats lose precision on mobile GPUs. Coordinates on large canvases and accumulated values need `highp` where the hardware has it, chosen from what the device supports rather than assumed.
- Shaders interpolate values between vertices, including values meant as IDs or enums. Use `flat` varyings or nearest sampling for discrete data.
- Values written to 8-bit targets are quantized, so repeated passes through them band.

Events and integration:
- A library's pointer events may not forward every DOM event, such as lost pointer capture or cancel. Handle the ones the interaction needs.
- Check object types with the library's `is*` flags rather than `instanceof`, which breaks when two copies of the library end up in the bundle.
- Don't load assets or presets from a third-party CDN in production.

Severity: "critical" for leaks that grow with use, anything that can lose the WebGL context or crash a supported device, and wrong output. "warning" for per-frame cost and idle rendering users will notice in frame rate or battery, and for missing context-loss handling. "suggestion" for the rest.
