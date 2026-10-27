# DJ Sync

Общая очередь вечеринки: гости кидают треки через сайт / Telegram / VK,
а один телефон у колонки играет их по WebSocket.

## Архитектура

```text
                    ┌─────────────┐
   Telegram TMA ───►│             │◄── Telegram bot
                    │   backend   │
   Browser SPA  ───►│  Fastify +  │◄── VK bot
                    │  WebSocket  │
   Player phone ───►│  + yt-dlp   │
                    └──────┬──────┘
                           │ /audio/*.mp3
                           ▼
                    data/audio/ (volume)
```

- **backend** — очередь, резолв (YouTube / поиск по названию), skip-голосование, WS
- **web** — SPA: гость + «режим динамика» + Telegram Mini App
- **telegram-bot** — текст, ссылки, аудио/голосовые, кнопка Mini App
- **vk-bot** — текст, ссылки, аудио из сообщества

Пока в очереди пусто, backend крутит **фоновый lo-fi** из одного локального файла
(`assets/lo-fi-halloween.mp3`, ~2 часа) — без скачивания, **зациклено**. Гостевой трек
сразу перебивает фон; очередь при этом не засоряется. В режиме динамика есть
переключатель `Lo-Fi: вкл/выкл`.

## Быстрый старт

```bash
cp .env.example .env
# заполни TELEGRAM_BOT_TOKEN / VK_GROUP_TOKEN / VK_GROUP_ID (если нужны боты)

docker compose up --build
```

- Веб: http://localhost:8088
- API: http://localhost:3000
- Аудио: http://localhost:3000/audio/…

### Телефон-динамик

1. Подключи колонку по Bluetooth.
2. Открой http://<ip-машины>:8088 с телефона.
3. Вкладка **Режим динамика** → **Включить режим динамика**.
4. Не блокируй экран (или разреши фоновое аудио в браузере).

### Гости

Сайт → ник → **Добавить**: ссылка (YouTube / Spotify / Я.Музыка) или название или файл.

- Spotify / Я.Музыка → ищем трек на YouTube по названию (офлайн-аудио оттуда не вытащить).
- Скип: вкладка **Скип** → «ЗА». Нужно `floor(гостей/2)+1` голосов.

## Переменные окружения

| Переменная | Где | Назначение |
|---|---|---|
| `PORT` | backend | HTTP порт (default 3000) |
| `WEB_ORIGIN` | backend | CORS origin фронта (default `http://localhost:8088`) |
| `BOT_SHARED_TOKEN` | backend, боты | общий секрет бот ↔ API |
| `TELEGRAM_BOT_TOKEN` | telegram-bot | токен BotFather |
| `WEB_APP_URL` | telegram-bot | https-URL Mini App / сайта |
| `VK_GROUP_TOKEN` | vk-bot | токен сообщества |
| `VK_GROUP_ID` | vk-bot | id сообщества |
| `API_URL` | боты | адрес backend (в compose — `http://backend:3000`) |
| `YTDLP_BIN` | backend | путь к yt-dlp (default `yt-dlp`) |
| `AUDIO_DIR` | backend | каталог файлов (default `data/audio`) |

## Локальная разработка (без Docker)

```bash
npm install
npm run dev --workspace @dj-sync/backend    # :3000
npm run dev --workspace @dj-sync/web        # :8080 (proxy → :3000)
npm run dev --workspace @dj-sync/telegram-bot
npm run dev --workspace @dj-sync/vk-bot
```

Для backend нужен `yt-dlp` и `ffmpeg` в PATH.

## Боты

Боты лежат в compose-профилях — не стартуют без токенов:

```bash
# Telegram
docker compose --profile telegram up -d telegram-bot

# VK
docker compose --profile vk up -d vk-bot
```

## API (кратко)

| Метод | Путь | Что делает |
|---|---|---|
| POST | `/api/join` | `{nickname, guestId?}` → гость |
| POST | `/api/tracks` | `{title?, url?}` или multipart file |
| POST | `/api/skip` | `{guestId, action: vote\|unvote}` |
| GET | `/api/state` | текущее состояние очереди |
| POST | `/api/player/command` | pause / resume / skip / volume |
| GET | `/ws` | WebSocket (guest / player) |
| POST | `/api/internal/tracks` | от ботов (Bearer `BOT_SHARED_TOKEN`) |
| POST | `/api/internal/upload` | файл от ботов |

## Типы клиентов WS

- `hello {role: "guest"\|"player", guestId, nickname}`
- сервер: `state`, `player:play|pause|resume|stop`, `vote:update`, `toast`
- плеер: `player:progress`, `player:ended {reason}`
