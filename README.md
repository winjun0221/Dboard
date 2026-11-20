# DBoard

Windows용 DB 관리 도구예요. SQLite · MySQL · MariaDB · PostgreSQL · SQL Server에 붙어서 표를 둘러보고, SQL을 실행하고, 데이터를 고칠 수 있어요.

[English](README.en.md)

![SQL 편집기](docs/editor.png)

## 내려받기

[Releases](https://github.com/winjun0221/dboard/releases/latest)에서 받으세요.

- `DBoard-Setup-<버전>.exe` — 설치 파일 (새 버전이 나오면 자동으로 받아 둠)
- `DBoard-<버전>-portable.exe` — 설치 없이 바로 실행 (자동 업데이트 없음)

Java나 DB 클라이언트를 따로 깔 필요가 없어요. 코드 서명이 아직 없어서 처음 실행할 때 Windows SmartScreen 경고가 나오면 "추가 정보 → 실행"을 눌러 주세요.

## 지원하는 DB

| 종류 | 같이 쓸 수 있는 DB |
|---|---|
| SQLite | 파일 하나 (`.db`, `.sqlite`) |
| MySQL · MariaDB | TiDB 등 MySQL 호환 DB |
| PostgreSQL | CockroachDB · TimescaleDB 등 PostgreSQL 호환 DB |
| SQL Server | Azure SQL |

## 할 수 있는 것

- **접속 관리** — 접속 정보 저장·복제·색 표시, 연결 시험, SSH 터널(비밀번호·개인 키), SSL
- **탐색기** — DB → 스키마 → 표·뷰 → 열·인덱스, 표 이름 찾기
- **SQL 편집기** — 문법 색칠, 자동 완성(입력하면 뜨고 `Tab`으로 넣기 · 표 이름, FROM에 쓴 표의 열, `별칭.열`), 커서 문장·고른 부분만 실행(`Ctrl+Enter`), 스크립트 전체 실행(`Alt+X`), 실행 중 취소, 실행 기록
- **결과 표** — 수만 행도 가볍게, 열 눌러 정렬, 칸·범위 복사(엑셀에 바로 붙여 넣기), CSV 내보내기
- **표 데이터 고치기** — 칸 고치기·행 추가·삭제, 되돌리기(`Ctrl+Z`), 저장 전에 실행할 SQL 미리 보기, 한 트랜잭션으로 저장(하나라도 실패하면 전부 되돌림)
- **DDL 보기 · CSV 가져오기** — 표 만드는 SQL 보기·복사, CSV 넣기(UTF-8·EUC-KR 자동 인식, 열 짝짓기)
- **SQL 덤프 · SQL 파일 실행** — DB·스키마·표를 구조(DDL)·데이터(INSERT)로 `.sql` 파일에 뽑기(외래 키 순서·자동 번호·계산 열을 맞춰서 다른 DB에 그대로 넣을 수 있게), `.sql` 파일을 골라 차례로 실행(오류가 나면 멈추고 되돌림)
- 한국어·영어 화면, 밝은·어두운 테마

![표 데이터 고치기](docs/data.png)

## 안전

- 비밀번호는 Windows 계정 암호화(DPAPI)로 저장해요. 다른 사용자·PC에서는 풀 수 없어요. "비밀번호 저장"을 끄면 연결할 때마다 물어봐요.
- SSH 서버의 호스트 키는 처음 연결할 때 기억하고, 바뀌면 연결하지 않아요.
- WHERE 없는 `UPDATE`·`DELETE`는 실행 전에 한 번 더 물어봐요.
- 표 데이터를 고칠 때는 값을 SQL에 직접 넣지 않고 자리 표시(`?`, `$1`)로 보내요.

## 단축키

| 키 | 하는 일 |
|---|---|
| `Ctrl+Enter` | 고른 부분, 없으면 커서가 있는 문장 실행 |
| `Alt+X` | 스크립트 전체 실행 |
| `Ctrl+Space` · `Tab` | 자동 완성 띄우기 · 넣기 |
| `Ctrl+/` | 주석 켜고 끄기 |
| `Ctrl+]` | 새 SQL 편집기 |
| `Ctrl+W` · `Ctrl+Tab` | 탭 닫기 · 다음 탭 |
| `Ctrl+S` · `Ctrl+Z` | 표 데이터 저장 · 되돌리기 |
| `Ctrl+C` · `Ctrl+Shift+C` | 결과 복사 · 열 이름과 함께 복사 |

## 직접 빌드

Node.js 24가 필요해요.

```bash
npm install
npm run dev        # 개발 실행
npm test           # 테스트
npm run test:db    # Docker로 MySQL·MariaDB·PostgreSQL·SQL Server를 띄워 실제 서버 테스트
npm run e2e        # 앱을 띄워 화면 테스트
npm run dist       # 설치 파일 → release/
```

MIT 라이선스. 같이 들어간 외부 패키지의 라이선스는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있어요.
