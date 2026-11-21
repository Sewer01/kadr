"""Границы, которые приложение задаёт само: длина ролика, размер картинки и глубина
списка референсов. Это не настройки человека, а пределы механизма - и они должны быть видны в одном
месте, а не разбросаны по обработчикам."""


MAX_REF_VIDEO = 25   # reference video: the model does not look further than this


H3IMG_MAX_PX = 20_000_000   # MiniMax H3 Image works at 4-20 MP: its own limit is far above the other picture models


MAX_SECONDS = 25.0  # H3 itself is made for up to 15 s; longer clips are allowed, quality is the user's call
