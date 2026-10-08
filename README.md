# wasmer-browser-test

Wasmer JavaScript SDK로 브라우저와 Node에서 WASIX 프로그램(python, ffmpeg, quickjs, bash, yt-dlp)이 실제로 동작하는지 확인하는 실험 저장소입니다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `test.mjs` | Node terminal용 스모크 테스트. 패키지 로드 → QuickJS/Python/FFmpeg 실행 → pip로 yt-dlp 설치·실행까지 순서대로 확인하고 PASS/FAIL을 요약해서 보여줍니다. |
| `serve.mjs` | `index.html`을 열어 볼 로컬 서버. 정적 서버(127.0.0.1:8321, COOP/COEP 격리 헤더 포함)와 WISP 프록시(127.0.0.1:5001)를 함께 띄웁니다. |
| `index.html` | 브라우저용 화면. **체인 검증** 탭은 `test.mjs`와 같은 내용을 브라우저 안에서 실행하고, **대화형 TTY** 탭은 xterm.js로 붙은 실제 터미널에서 bash·python REPL·qjs를 직접 입력하며 쓸 수 있습니다. |

## 실행 방법

의존성 설치는 한 번만 하면 됩니다.

```bash
npm install
```

### Node terminal에서 확인

```bash
node test.mjs            # 전체 실행 (pip·yt-dlp 포함, 약 1분)
node test.mjs --no-net   # 네트워크 단계 생략, 바이너리 호출만 확인
```

### 브라우저에서 확인

```bash
node serve.mjs
# http://127.0.0.1:8321/ 을 연 뒤 실행 버튼 또는 대화형 TTY 탭 사용
```

`file://`로 여면 SharedArrayBuffer가 막혀서 SDK가 동작하지 않으므로 반드시 serve.mjs로 접속합니다.

## 어떻게 동작하나요?

- wasmer.io 레지스트리의 패키지는 CPython·FFmpeg·QuickJS 등을 **wasm32-wasix로 미리 컴파일해 둔 실행 파일**입니다. SDK가 이것들을 내려받아 브라우저 Cache Storage에 캐시하고, Web Worker 안의 Wasmer 런타임에서 실행합니다.
- 프로그램의 파일 접근은 메모리 가상 파일시스템으로, TCP 소켓은 WASIX syscall로 처리됩니다. 브라우저에서 TCP는 WISP(WebSocket 기반 프로토콜)로 `serve.mjs`의 프록시를 통해 나갑니다. Node에서는 `node:net`으로 직접 연결되므로 WISP가 필요 없습니다.
- python 빌드는 스레드를 쓰기 때문에 공유 메모리가 필요하고, 이를 위해 COOP/COEP 응답 헤더가 필수입니다. serve.mjs가 모든 응답에 이 헤더를 붙입니다.
- 대화형 TTY는 SDK의 `terminal: { columns, rows }` spawn 옵션과 xterm.js를 연결한 것입니다. `TERM`·`PATH` 등의 환경 변수를 공식 wasmer-sh 데모와 동일하게 세팅해야 REPL 프롬프트와 에코가 정상 동작합니다.

## 고정한 버전

| 항목 | 값 |
| --- | --- |
| JavaScript SDK | `@wasmer/sdk@0.19.1` |
| Python | `python/python@=3.13.20` (실행 시 3.13.15로 표시됨) |
| QuickJS | `wasmer/quickjs@=0.15.1` |
| FFmpeg | `wasmer/ffmpeg@=1.0.5` |
| yt-dlp | `2026.8.19` |
| WISP | `@mercuryworkshop/wisp-js@0.4.1` |

## 검증 결과 (2026-10-08, Node 26 · Chromium)

- Node와 브라우저 양쪽에서 7~8단계 전부 통과. QuickJS 실행, `python --version`, `ffmpeg -version`, pip로 yt-dlp 설치 후 `--version`·`--help` 출력 확인.
- 브라우저에서는 WISP 프록시를 통해 pip 네트워크까지 동작하는 것을 확인했고, 대화형 TTY에서 bash(`ls`, `cd`, `/bin` 열람)와 python REPL 입력이 정상 동작했습니다.

## 주의 사항

- 이 저장소는 **로컬 검증 전용** 실험입니다. WISP 프록시는 인증도 목적지 제한도 루프백 바인딩밖에 없어서 공개 배포하면 안 됩니다.
- SDK의 라이선스(attribution 조건이 추가된 Modified MIT)와 wisp-js의 **AGPL-3.0** 라이선스는 이 구조를 실제 서비스에 결합하기 전에 별도 검토가 필요합니다.
- python 패키지 버전 핀(3.13.20)과 실제 실행 버전(3.13.15)이 다르게 표시되는데, 패키지 버전과 내부 CPython 빌드 패치 버전의 차이로 보입니다.
