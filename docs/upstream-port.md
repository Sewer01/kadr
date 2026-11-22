# Разбор изменений автора и что из них берём

Сравнивали с общей точкой `3e9b9d5fe212`. С тех пор у нас больше 400 коммитов,
у автора 11 коммитов и 14335 добавленных строк в 33 файлах. Полное слияние
невозможно: она живёт в одном файле `app/ui/index.html` (сейчас 1,27 МБ), мы
разложили интерфейс на 22 модуля. Переносим только осмысленные куски, по одному
на релиз, и каждый раз проверяем снимком интерфейса и живой пробой.

Проверял её файлы из `up/main` (забрано `git fetch up`), не на глаз: размеры,
заголовки модулей, строки интерфейса и место в коде.

## Что у неё нового

| Файл | Размер | Что делает |
|---|---|---|
| `app/projects.py` | 11 КБ | Проекты для чата модели: папка с документами, скиллами и сводкой-памятью |
| `app/refmodes.py` | 8 КБ | Карточки актёров, транспорта, предметов и локаций |
| `app/reflab.py` | 24 КБ | Reference Lab: лист референсов из одного короткого видео |
| `app/voicelab.py` | 17 КБ | Voice Lab: синтез речи (design, clone, длинный текст, несколько говорящих) |
| `app/websearch.py` | 3 КБ | Поиск в интернете без ключа через страницу Bing |
| `app/rhlib.py`, `app/rhstudio.py`, `app/rh_workflows/*.json` | 25 КБ | Облачные режимы RunningHub |
| `app/skills/rezhisser-scenarist/SKILL.md` | 20 КБ | Скилл «режиссёр-сценарист» |
| `app/skills/minimax-h3-image/SKILL.md`, `app/skills/drama-minimax-h3/**` | 12 КБ | Скиллы картинок и драмы |
| `app/mp4info.py` | 2 КБ | Чтение сведений о видео |

## Режим «режиссёр-сценарист»

Как у неё. Это не отдельная вкладка, а одна из целей чата: `AG.target ===
'script'`, и под полем появляется подсказка «Сценарист и режиссёр: опишите идею,
героя, настроение (можно приложить фото и музыку) - модель задаст вопросы и
напишет». Скилл включается словом «режиссёр» в начале сообщения, плюс человек
может руками выбрать скиллы чата плашками (`AG.chatSk`, загрузка файлов через
`/api/agent/skills`). Текст скилла требует выдачу из трёх блоков: сценарий в
киноформате, таблица раскадровки (крупность, ракурс, действие, движение камеры,
свет, хронометраж) и промпт на каждый кадр на английском; для музыки - раскладка
по BPM и тактам.

Кнопки переноса для `chat` и `script` у неё спрятаны: сценарий человек переносит
вручную. Именно это нас не устраивает.

Что берём. Сам текст скилла (он выверенный: единая палитра, единый герой во всех
промптах, проверка суммы хронометража, запрет «вариантов на выбор»), идею
подсказки под полем и выбор скилла плашками.

Что делаем по-своему. Отдельная вкладка «Сценарист», общий сценарий без привязки
к аудио и фото, один глобальный выбор скила, и активная кнопка «Отправить»,
которая кладёт сценарий в окно «Сценарий» выбранного режима. Ручной перенос
текста - это та работа, от которой мы уходим.

## Проекты для модели (`projects.py`)

Папка `DATA_DIR/projects/<id>`: `project.json`, `docs/*.txt`, `skills/*.md`,
`summary.md`. Чаты лежат отдельно и привязаны к проекту полем `project`.
Модель получает: скиллы проекта (16000 знаков), сводку (6000), документы (24000,
мелкие целиком, крупные кусками по 1500 знаков, подобранными под вопрос).
Документы принимаются `.md`, `.txt`, `.docx` (текст Word читается без лишних
библиотек) и архивом `.zip`, повреждённый архив не пишется молча.

Вердикт: полезно и хорошо устроено, но это следующий шаг после Сценариста: без
общего сценария проекты некому наполнять. Переносим идею сводки-памяти и
подбора документов по вопросу, файл берём почти как есть - он ни от чего, кроме
`DATA_DIR`, не зависит.

## Карточки актёров (`refmodes.py` и модуль `RMODE` в её странице)

Карточка: тип (персонаж, автомобиль, предмет, локация), до девяти картинок, у
каждой вкл или выкл, необязательный образец голоса, короткий текст (что это и что
сохранять). Список в `data/refmodes.json`, файлы в `data/refmodes/<id>/`. Битый
список не перезаписывается молча: копия рядом (`refmodes.broken.json`) - приём
правильный, берём.

Как работает в режимах: страницы берут включённые картинки отмеченных карточек
как референсы, а `@имя` в тексте сцены заменяются тегом картинки плюс одной
строкой определения. Замена сделана в её `index.html`.

Вердикт: это основа релиза «модули актёров». Берём модель данных и поведение
`@имя`, но подстановку делаем в нашем модуле окна «Сценарий», а не в странице, и
образец голоса связываем с нашим голосовым модулем, а не с её Voice Lab.

## Reference Lab (`reflab.py`) - наш «супер-референс»

Из одного короткого видео (8 секунд) строит лист референсов персонажа, объекта
или локации: набор пресетов движения камеры, у каждого название, подсказка и
тайминги; для человека показываются русские описания, модель читает английские.
Картинки уходят в MiniMax H3 тем же графом, что страница «Референсы». Работы
хранятся пачкой, новых 80 не помеченных держатся на диске.

Вердикт: это и есть супер-референс, релиз после актёров. Из её кода берём
пресеты движения и пары «русское описание - английский текст для модели», граф
ставим свой.

## Voice Lab (`voicelab.py`)

Синтез речи на нодах OmniVoice: дизайн голоса по описанию (пол, возраст, тонка,
акцент), клонирование по образцу, длинный текст кусками, до четырёх говорящих;
качество три ступени (16, 32, 64 шага), образец голоса до 60 МБ, последних 60
немеченых дублей держатся на диске, для смены голоса отдельный пакет Chatterbox с
зафиксированным коммитом.

Вердикт: это про синтез, а голосовой ввод (2.2.30) - про распознавание, у неё
такого нет (whisper в её файлах не встретился). Смотрим её список нод и способ
фиксировать коммит пакета, остальное пишем сами на локальном whisper.

## Поиск в интернете (`websearch.py`)

Страница Bing без ключа (DuckDuckGo показывает проверку на робота), разбор
блоков `b_algo`, разворачивание редиректов `bing.com/ck/a` через base64, три
попытки на случай пустой страницы, ограничение пять результатов. Включается
переключателем в чате: «только знания модели» или «искать в интернете».

Вердикт: берём как есть, модуль маленький и самостоятельный. Включаем в чат
позже, отдельным релизом.

## Чего не берём

Облачные режимы RunningHub (`rhlib.py`, `rhstudio.py`, `app/rh_workflows/*.json`):
наш продукт работает на локальной ComfyUI, чужие облачные ключи нам не нужны, и
ноды этих графов у нас не установлены. Вместе с ними не переносим ни «свои
рабочие процессы» в боковой панели, ни аренду серверов с логином и паролем.

Единственный файл страницы вместо модулей - не берём принципиально: именно из-за
него правка в одном месте у неё ломает другие.

## Редактор аудио

Отдельного редактора аудио у неё нет: в её странице нет ни надписи «редактор
аудио», ни работы с волной. Есть подгонка аудио при сборке и образцы звука в
экшн-студии. Сравнивать не с чем, наш редактор - своя работа.

## Отдельно: пробел в наших проверках

Заглушка DOM в `tools/checks/esmbodies.mjs` отвечает элементом на любой запрос
(`querySelector: () => any`), поэтому код, который читает поле до того, как оно
создано, в проверке выглядит живым: поломка модуля окна («Cannot set properties
of null») была видна только живой пробе в браузере. Что делать: превратить
заглушку в крошечный реестр созданных узлов (`createElement`, `appendChild`,
разбор `id` и `class` из `innerHTML`), и отдавать элемент только если его
правда создали. До этого момента порядок создания полей в теле модуля
проверяется только пробой.

## Пресеты движения из её reflab.py (выписаны разбором файла, 22.11)

Ролик длится 8.0 секунд: каждый кадр берётся в свою долю длительности, у кадра есть
короткое имя и английская фраза про камеру. Ниже - как у неё, без перевода на глаз.

**location / coverage - Со всех сторон.** общий · с обратной стороны · слева · справа · деталь (8 с)
- `общий` на 0%: wide establishing shot of the whole place, eye level, the camera is still
- `обратно` на 30%: the camera has turned around and now looks at the place from the opposite side, reverse shot
- `слева` на 55%: the camera is moving along the left side of the place, left side view
- `справа` на 80%: the camera is moving along the right side of the place, right side view
- `деталь` на 100%: slow push in to a close-up of one characteristic detail of the place

**location / pan360 - Осмотр на месте 360°.** камера стоит и поворачивается вокруг (8 с)
- `0°` на 0%: the camera stands still and looks straight ahead
- `90°` на 25%: the camera has turned in place a quarter of a full turn to the right
- `180°` на 50%: the camera has turned half a turn and looks at the opposite side
- `270°` на 75%: the camera has turned three quarters of a full turn
- `360°` на 100%: the camera has finished the full turn and looks straight ahead again

**location / walk - Пройтись по месту.** камера идёт вперёд по месту (8 с)
- `вход` на 0%: wide shot at the entrance of the place, the camera starts to walk forward
- `вперёд` на 35%: the camera keeps walking forward at walking speed, the place opens up around
- `середина` на 70%: the camera is in the middle of the place and slowly looks around
- `вглубь` на 100%: the camera has reached the far side of the place and looks back

**location / time - Время суток.** то же место утром, днём, вечером, ночью (8 с)
- `рассвет` на 0%: the same view at dawn, soft pink light, long shadows
- `день` на 30%: the same view at noon, bright sun, short shadows
- `закат` на 60%: the same view at golden hour, warm low light
- `ночь` на 100%: the same view at night, artificial lights and moonlight

**location / empty - Пустая сцена.** место без людей, спокойный облёт (6 с)
- `начало` на 0%: empty place without any people, the camera is still
- `сдвиг` на 50%: the camera drifts slowly to the right, still no people
- `конец` на 100%: the camera ends on the opposite corner of the empty place

**location / single - Один дубль.** один кадр места (5 с)
- `кадр` на 50%: one steady wide shot of the place

**location / custom - Свой.** свои ракурсы (8 с)
- `ракурс 1` на 0%: wide shot of the place

**character / face - Поворот лица.** левый профиль · анфас · правый профиль (6 с)
- `слева` на 0%: head and shoulders close-up, the face turned fully to the left in profile
- `анфас` на 50%: the head slowly turns to look straight into the camera, front view
- `справа` на 100%: the head keeps turning and ends fully to the right in profile

**character / orbit360 - Поворот 360°.** камера облетает героя в полный рост · 5 кадров: спереди, 3/4, бок, сзади, другой бок (12 с)
- `спереди` на 0%: full body front view, the person stands completely still in a relaxed neutral pose, the camera starts one slow smooth orbit around them
- `3/4` на 12%: the camera has orbited 45 degrees around the standing person, three-quarter view, full body from head to feet in the frame
- `бок` на 25%: the camera has orbited 90 degrees around the standing person, side profile view, full body from head to feet in the frame
- `сзади` на 50%: the camera has orbited 180 degrees around the standing person, back view, full body from head to feet in the frame
- `другой бок` на 75%: the camera has orbited 270 degrees around the standing person, side profile view from the other side, full body from head to feet in the frame

**character / single - Один дубль.** один кадр героя (5 с)
- `кадр` на 50%: one steady full body shot of the person facing the camera

**character / custom - Свой.** свои ракурсы (8 с)
- `ракурс 1` на 0%: full body front view

**object / table - Поворот на столе.** предмет медленно крутится на месте (8 с)
- `спереди` на 0%: the object stands on a plain surface seen from the front
- `бок` на 25%: the object has turned a quarter turn, side view
- `сзади` на 50%: the object has turned half a turn, seen from behind
- `другой бок` на 75%: the object has turned three quarters, the other side view
- `сверху` на 100%: the camera rises and looks at the object from above

**object / detail - Детали.** общий вид и крупные планы (8 с)
- `общий` на 0%: the whole object in the frame, still camera
- `деталь 1` на 40%: slow push in to a close-up of the most characteristic detail of the object
- `деталь 2` на 75%: the camera moves along the object to another detail, close-up
- `фактура` на 100%: extreme close-up of the surface and the material of the object

**object / single - Один дубль.** один кадр предмета (5 с)
- `кадр` на 50%: one steady shot of the object

**object / custom - Свой.** свои ракурсы (8 с)
- `ракурс 1` на 0%: the whole object seen from the front

