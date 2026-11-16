# Third-party notices

The application bundles third-party JavaScript; additional bundled notices are retained in `dist/ui/app.js.LEGAL.txt`. Electron retains its own Chromium and runtime licenses.

## shadcn/ui and CLI

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Phosphor Icons

MIT License

Copyright (c) 2020 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Third-party media tools

Tamki invokes FFmpeg as a separate executable for local audio/video remuxing. It does not link FFmpeg libraries into Electron.

## macOS and Linux

The bundled remuxer is built from unmodified FFmpeg 8.0.1, copyright the FFmpeg developers, under LGPL 2.1 or later. Its minimal build disables external libraries, GPL/nonfree features and networking. Only the file protocol and the media formats needed by the adapter are enabled.

- Upstream: https://ffmpeg.org/
- Corresponding source: https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz
- SHA256: `05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41`
- Build recipe: [scripts/media-tool.mjs](scripts/media-tool.mjs)

The executable, LGPL license, upstream license notes, complete unmodified source archive and exact build recipe/configuration are distributed together in `dist/tools` (inside `app.asar.unpacked` for packaged applications). Users can rebuild and replace this separate executable. There are no FFmpeg source patches.

## Windows and development test fixtures

The `ffmpeg-static` npm wrapper is GPL 3.0 or later. Its platform binaries have their own FFmpeg configuration and license. The Windows build copies the binary license, wrapper license, upstream README and actual configuration alongside the executable and refuses a build containing `--enable-nonfree`. The relevant binary and source distribution is https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1. Windows packaging has not been validated in this macOS development session.

The npm development binary generates and verifies synthetic test media; it is not the executable included in macOS/Linux packages. Other npm dependencies retain their respective licenses.

# 第三方媒体工具

Tamki 通过独立进程调用 FFmpeg 合并本地音视频，不将 FFmpeg 库链接进 Electron。macOS/Linux 使用未修改的 FFmpeg 8.0.1 官方源码构建，遵循 LGPL 2.1 或更新版本，关闭外部库、GPL/nonfree 特性与联网能力。完整源码、许可证、构建方法和配置与程序一起放在安装包的 `dist/tools` 中；用户可重新编译并替换该独立程序。

Windows 使用 `ffmpeg-static` 对应平台程序，保留二进制及包装器许可信息，并拒绝包含 `--enable-nonfree` 的构建。本次 macOS 开发未验证 Windows 打包。npm 开发依赖中的媒体程序只用于生成和检查测试媒体，不随 macOS/Linux 安装包分发。源码地址、校验和与具体构建方法见上方。

## dash.js

DASH Industry Forum — BSD 3-Clause License.

# dash.js BSD License Agreement

The copyright in this software is being made available under the BSD License, included below. This software may be subject to other third party and contributor rights, including patent rights, and no such rights are granted under this license.

**Copyright (c) 2015, Dash Industry Forum.
**All rights reserved.**
 
* Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the  documentation and/or other materials provided with the distribution.
* Neither the name of the Dash Industry Forum nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

**THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS “AS IS” AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.**
 
