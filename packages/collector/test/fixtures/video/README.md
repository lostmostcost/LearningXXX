# Synthetic MP4 fixture

`black.mp4` is 0.2 seconds of generated black 16×16 H.264 video, without audio,
lecture content, metadata from a user, credentials, or downloaded media.

Generated locally with FFmpeg (no runtime/test dependency):

```sh
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=16x16:d=0.2 -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an black.mp4
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height -of json black.mp4
```

Observed: H.264, 16×16, 0.200000 seconds, 1689 bytes. Tests mutate copies to
exercise truncated payloads, encryption markers, broken sample tables and
chunk offsets. The checked-in fixture keeps FFmpeg out of the container.
