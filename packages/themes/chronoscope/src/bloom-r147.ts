// UnrealBloomPass as it was in three.js r147 (MIT, © three.js authors), which the Chronoscope design was designed
// with. r155+ rewrote the blur (kernels 6–22 instead of 3–11, different weights) and uses HalfFloat targets, so
// the same strength / radius / threshold glow far wider and wash the dials out. This keeps the original design's look.

import { AdditiveBlending, Color, MeshBasicMaterial, ShaderMaterial, UniformsUtils, Vector2, Vector3, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

const VS = `varying vec2 vUv;
void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;

const HIGH_PASS_FS = `uniform sampler2D tDiffuse;uniform float luminosityThreshold;uniform float smoothWidth;varying vec2 vUv;
void main(){vec4 texel=texture2D(tDiffuse,vUv);float v=dot(texel.xyz,vec3(0.299,0.587,0.114));
 gl_FragColor=mix(vec4(0.0),texel,smoothstep(luminosityThreshold,luminosityThreshold+smoothWidth,v));}`;

const BLUR_FS = `varying vec2 vUv;uniform sampler2D colorTexture;uniform vec2 texSize;uniform vec2 direction;
float gaussianPdf(in float x,in float sigma){return 0.39894*exp(-0.5*x*x/(sigma*sigma))/sigma;}
void main(){vec2 invSize=1.0/texSize;float fSigma=float(SIGMA);float weightSum=gaussianPdf(0.0,fSigma);
 vec3 diffuseSum=texture2D(colorTexture,vUv).rgb*weightSum;
 for(int i=1;i<KERNEL_RADIUS;i++){float x=float(i);float w=gaussianPdf(x,fSigma);vec2 uvOffset=direction*invSize*x;
  diffuseSum+=(texture2D(colorTexture,vUv+uvOffset).rgb+texture2D(colorTexture,vUv-uvOffset).rgb)*w;weightSum+=2.0*w;}
 gl_FragColor=vec4(diffuseSum/weightSum,1.0);}`;

const COMPOSITE_FS = `varying vec2 vUv;
uniform sampler2D blurTexture1;uniform sampler2D blurTexture2;uniform sampler2D blurTexture3;uniform sampler2D blurTexture4;uniform sampler2D blurTexture5;
uniform float bloomStrength;uniform float bloomRadius;uniform float bloomFactors[NUM_MIPS];uniform vec3 bloomTintColors[NUM_MIPS];
float lerpBloomFactor(const in float factor){return mix(factor,1.2-factor,bloomRadius);}
void main(){gl_FragColor=bloomStrength*(
 lerpBloomFactor(bloomFactors[0])*vec4(bloomTintColors[0],1.0)*texture2D(blurTexture1,vUv)+
 lerpBloomFactor(bloomFactors[1])*vec4(bloomTintColors[1],1.0)*texture2D(blurTexture2,vUv)+
 lerpBloomFactor(bloomFactors[2])*vec4(bloomTintColors[2],1.0)*texture2D(blurTexture3,vUv)+
 lerpBloomFactor(bloomFactors[3])*vec4(bloomTintColors[3],1.0)*texture2D(blurTexture4,vUv)+
 lerpBloomFactor(bloomFactors[4])*vec4(bloomTintColors[4],1.0)*texture2D(blurTexture5,vUv));}`;

const KERNELS = [3, 5, 7, 9, 11];
const MIPS = KERNELS.length;
const DIR_X = new Vector2(1, 0);
const DIR_Y = new Vector2(0, 1);

export class BloomPassR147 extends Pass {
  strength: number;
  radius: number;
  threshold: number;
  private targetsH: WebGLRenderTarget[] = [];
  private targetsV: WebGLRenderTarget[] = [];
  private bright: WebGLRenderTarget;
  private highPass: ShaderMaterial;
  private blurs: ShaderMaterial[];
  private composite: ShaderMaterial;
  private copy: ShaderMaterial;
  private basic = new MeshBasicMaterial();
  private quad = new FullScreenQuad(undefined);
  private oldClear = new Color();

  constructor(resolution: Vector2, strength: number, radius: number, threshold: number) {
    super();
    this.strength = strength;
    this.radius = radius;
    this.threshold = threshold;
    // Default 8-bit targets, as in r147: everything clips at 1.
    let x = Math.round(resolution.x / 2);
    let y = Math.round(resolution.y / 2);
    this.bright = new WebGLRenderTarget(x, y);
    this.bright.texture.generateMipmaps = false;
    this.blurs = KERNELS.map((k) => {
      const h = new WebGLRenderTarget(x, y);
      const v = new WebGLRenderTarget(x, y);
      h.texture.generateMipmaps = v.texture.generateMipmaps = false;
      this.targetsH.push(h);
      this.targetsV.push(v);
      const m = new ShaderMaterial({
        defines: { KERNEL_RADIUS: k, SIGMA: k },
        uniforms: { colorTexture: { value: null }, texSize: { value: new Vector2(x, y) }, direction: { value: DIR_X } },
        vertexShader: VS,
        fragmentShader: BLUR_FS,
      });
      x = Math.round(x / 2);
      y = Math.round(y / 2);
      return m;
    });
    this.highPass = new ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, luminosityThreshold: { value: threshold }, smoothWidth: { value: 0.01 } },
      vertexShader: VS,
      fragmentShader: HIGH_PASS_FS,
    });
    const tex: Record<string, { value: unknown }> = {};
    this.targetsV.forEach((t, i) => (tex[`blurTexture${i + 1}`] = { value: t.texture }));
    this.composite = new ShaderMaterial({
      defines: { NUM_MIPS: MIPS },
      uniforms: {
        ...tex,
        bloomStrength: { value: strength },
        bloomRadius: { value: radius },
        bloomFactors: { value: [1.0, 0.8, 0.6, 0.4, 0.2] },
        bloomTintColors: { value: KERNELS.map(() => new Vector3(1, 1, 1)) },
      },
      vertexShader: VS,
      fragmentShader: COMPOSITE_FS,
    });
    this.copy = new ShaderMaterial({
      uniforms: UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.copy.uniforms.opacity.value = 1;
    this.needsSwap = false;
  }

  setSize(width: number, height: number): void {
    let x = Math.round(width / 2);
    let y = Math.round(height / 2);
    this.bright.setSize(x, y);
    for (let i = 0; i < MIPS; i++) {
      this.targetsH[i].setSize(x, y);
      this.targetsV[i].setSize(x, y);
      this.blurs[i].uniforms.texSize.value = new Vector2(x, y);
      x = Math.round(x / 2);
      y = Math.round(y / 2);
    }
  }

  render(renderer: WebGLRenderer, _write: WebGLRenderTarget, read: WebGLRenderTarget, _dt: number, maskActive: boolean): void {
    renderer.getClearColor(this.oldClear);
    const oldAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    if (maskActive) renderer.state.buffers.stencil.setTest(false);
    if (this.renderToScreen) {
      this.quad.material = this.basic;
      this.basic.map = read.texture;
      renderer.setRenderTarget(null);
      renderer.clear();
      this.quad.render(renderer);
    }
    // 1. Bright areas.
    this.highPass.uniforms.tDiffuse.value = read.texture;
    this.highPass.uniforms.luminosityThreshold.value = this.threshold;
    this.quad.material = this.highPass;
    renderer.setRenderTarget(this.bright);
    renderer.clear();
    this.quad.render(renderer);
    // 2. Blur each mip, horizontally then vertically.
    let input = this.bright;
    for (let i = 0; i < MIPS; i++) {
      const m = this.blurs[i];
      this.quad.material = m;
      m.uniforms.colorTexture.value = input.texture;
      m.uniforms.direction.value = DIR_X;
      renderer.setRenderTarget(this.targetsH[i]);
      renderer.clear();
      this.quad.render(renderer);
      m.uniforms.colorTexture.value = this.targetsH[i].texture;
      m.uniforms.direction.value = DIR_Y;
      renderer.setRenderTarget(this.targetsV[i]);
      renderer.clear();
      this.quad.render(renderer);
      input = this.targetsV[i];
    }
    // 3. Composite the mips, then add over the input.
    this.quad.material = this.composite;
    this.composite.uniforms.bloomStrength.value = this.strength;
    this.composite.uniforms.bloomRadius.value = this.radius;
    renderer.setRenderTarget(this.targetsH[0]);
    renderer.clear();
    this.quad.render(renderer);
    this.quad.material = this.copy;
    this.copy.uniforms.tDiffuse.value = this.targetsH[0].texture;
    if (maskActive) renderer.state.buffers.stencil.setTest(true);
    renderer.setRenderTarget(this.renderToScreen ? null : read);
    this.quad.render(renderer);
    renderer.setClearColor(this.oldClear, oldAlpha);
    renderer.autoClear = oldAutoClear;
  }

  dispose(): void {
    [...this.targetsH, ...this.targetsV, this.bright].forEach((t) => t.dispose());
    [...this.blurs, this.highPass, this.composite, this.copy, this.basic].forEach((m) => m.dispose());
    this.quad.dispose();
  }
}
