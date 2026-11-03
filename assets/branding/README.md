# YOLO UNIV · WBS-093

CR-093 / 사용자 직접 승인. 학사모를 쓴 YOLO를 글자 캐릭터로 표현했습니다.
짙은 남색 글자·학사모, 금색 술, 아이보리 앱 타일을 사용합니다.

- `yolo-univ-logo.png`: 투명 배경의 가로 로고, YOLO UNIV 전체 이름.
- `yolo-univ-icon-source.png`: 원본 앱 아이콘. YO / LO 두 줄과 학사모, 원본 보존.
- `yolo-univ-icon.png`: 1024×1024 앱 적용용 PNG.
- `yolo-univ.icns`: macOS 네이티브 아이콘, 16/32/128/256/512 및 각 @2x 크기 포함.
- `generation.json`: 내장 image_gen 도구에 사용한 최종 프롬프트와 제작 경로.

앱 이름·로고·Dock 아이콘 적용은 WBS-094입니다. 이 자산만 병합해도 현재 실행 앱의
이름이나 아이콘이 바뀌지는 않습니다. WBS-085의 host/ui/shared 선점을 건드리지 않았습니다.
기존 데이터·로그인·세션의 저장 경로를 이 자산 작업에서 변경하지 않았습니다.

macOS에서 원본을 변형하지 않고 파생 크기를 다시 만들려면:

```sh
bash assets/branding/build-icon.sh
```

`/usr/bin/sips`와 `/usr/bin/iconutil`을 사용합니다. 네트워크·패키지 설치는 필요하지 않습니다.
자기 임시 폴더에서 크기별 PNG와 ICNS를 만들고 성공한 결과만 자산 폴더로 복사합니다.
실패하면 원본과 기존 결과를 보존하고 임시 폴더는 정리됩니다. 샌드박스에서 iconutil이
정상 iconset에도 Invalid Iconset을 반환했으나 동일 명령의 허용된 host 실행은 통과했습니다.

검토: 원래 로고의 회색 halo/입자 배경을 발견해 image_gen으로 제거한 판을 채택했습니다.
아이콘 배경 제거 시도는 가장자리 입자로 채택하지 않고 깨끗한 원본 타일 판을 사용했습니다.
로고의 문구·학사모·배경과 64px 아이콘의 글자/학사모를 직접 시각 검토했습니다.
PNG 크기/alpha를 sips로 확인하고 ICNS를 iconutil로 다시 풀어 10개 표준 PNG를 확인했습니다.
앱 적용 후 실제 Dock·창에서의 모습은 WBS-094에서 확인해야 합니다. 벡터 원본은 없습니다.
