# Generated media fixture

`video.webm` is a six-second FFmpeg `testsrc2` pattern, generated for Tamki tests. It contains no personal or third-party media. No FFmpeg installation is needed to run the tests.

```sh
ffmpeg -f lavfi -i 'testsrc2=size=480x270:rate=24' -t 6 -c:v libvpx -b:v 140k -an video.webm
```
