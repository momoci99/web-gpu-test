import { FIXED_DT, stepScene } from '../scene';
import { mountCanvas } from './canvas-util';
import type { RendererEntry } from './types';

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_state;
layout(location = 1) in float a_radius;
layout(location = 2) in vec4 a_color;
uniform vec2 u_size;
out vec2 v_local;
flat out float v_radius;
out vec4 v_color;

const vec2 CORNERS[6] = vec2[6](
  vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
  vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
);

void main() {
  vec2 local = CORNERS[gl_VertexID] * (a_radius + 1.0);
  vec2 px = a_state.xy + local;
  gl_Position = vec4(px.x / u_size.x * 2.0 - 1.0, 1.0 - px.y / u_size.y * 2.0, 0.0, 1.0);
  v_local = local;
  v_radius = a_radius;
  v_color = a_color;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_local;
flat in float v_radius;
in vec4 v_color;
out vec4 outColor;

void main() {
  float cover = 1.0 - smoothstep(v_radius - 0.5, v_radius + 0.5, length(v_local));
  if (cover <= 0.0) discard;
  float a = v_color.a * cover;
  outColor = vec4(v_color.rgb * a, a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`셰이더 컴파일 실패: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}

export const webgl2Entry: RendererEntry = {
  id: 'webgl2',
  label: 'WebGL2',
  summary: '인스턴스 쿼드 한 번의 draw call로 그립니다. 시뮬레이션은 CPU에서 하고 매 프레임 bufferSubData로 올립니다.',
  requires: 'webgl2',
  async create(host, scene, caps) {
    const { width, height, count } = scene.config;
    const canvas = mountCanvas(host, scene.config, caps.dpr);
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: true });
    if (!gl) throw new Error('WebGL2 컨텍스트를 만들 수 없습니다');

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`프로그램 링크 실패: ${gl.getProgramInfoLog(prog)}`);
    gl.useProgram(prog);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_size'), width, height);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const stateBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
    gl.bufferData(gl.ARRAY_BUFFER, scene.state.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(0, 1);

    const radiusBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, radiusBuf);
    gl.bufferData(gl.ARRAY_BUFFER, scene.radius, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    const colorBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, scene.color, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 4, 0);
    gl.vertexAttribDivisor(2, 1);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);

    let disposed = false;
    return {
      id: 'webgl2',
      frame() {
        stepScene(scene, FIXED_DT);
        gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, scene.state);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        gl.deleteBuffer(stateBuf);
        gl.deleteBuffer(radiusBuf);
        gl.deleteBuffer(colorBuf);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(prog);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        canvas.remove();
      },
    };
  },
};
