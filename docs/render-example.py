"""Draw the usage illustration for the README (no real session data).

    python docs/render-example.py docs/example.png
"""
import re
import sys

from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else "example.png"
S = 2  # supersample for crisp text

BG = (24, 25, 29)
CARD = (32, 33, 39)
CARD_2 = (45, 47, 55)
TRACK = (58, 61, 72)
TEXT = (232, 234, 240)
DIM = (150, 155, 168)
DIM_2 = (120, 125, 138)
ACCENT = (77, 107, 254)
GREEN = (0, 168, 107)

SANS = "C:/Windows/Fonts/msyh.ttc"
MONO = "C:/Windows/Fonts/consola.ttf"
CJK = re.compile(r"[\u3000-\u9fff]")


def font(path, size):
    try:
        return ImageFont.truetype(path, size * S)
    except Exception:
        return ImageFont.load_default()


f_title = font(SANS, 15)
f_label = font(SANS, 12)
f_small = font(SANS, 11)
f_tiny = font(SANS, 10)
f_value = font(MONO, 34)
f_money = font(MONO, 15)
f_num = font(MONO, 12)
f_num_cjk = font(SANS, 12)
f_mono_small = font(MONO, 11)
f_tag = font(MONO, 9)

W, H = 720, 672
img = Image.new("RGB", (W * S, H * S), BG)
d = ImageDraw.Draw(img)


def num_font(text):
    return f_num_cjk if CJK.search(text) else f_num


def rounded(box, radius, fill=None, outline=None, width=1):
    d.rounded_rectangle([c * S for c in box], radius=radius * S, fill=fill, outline=outline, width=width * S)


def text(xy, s, f, color=TEXT, anchor="la"):
    d.text((xy[0] * S, xy[1] * S), s, font=f, fill=color, anchor=anchor)


def value(x, y, s, color=TEXT, anchor="ra"):
    text((x, y), s, num_font(s), color, anchor=anchor)


rounded((0, 0, W - 1, H - 1), 14, BG)

# ---- header: session title + chip ----
text((26, 24), "新的会话", f_title)
chip_w, chip_h = 238, 34
chip_x = W - 26 - chip_w
rounded((chip_x, 18, chip_x + chip_w, 18 + chip_h), 10, CARD_2, (70, 74, 88), 1)
d.ellipse([(chip_x + 14) * S, (18 + 14) * S, (chip_x + 14 + 8) * S, (18 + 14 + 8) * S], fill=ACCENT)
text((chip_x + 28, 27), "¥120.00", f_money, TEXT)
text((chip_x + 104, 31), "DS", f_tag, DIM_2)
value(chip_x + 132, 27, "3241万", DIM)
text((chip_x + 186, 31), "6 会话", f_tiny, DIM_2)

# ---- popover panel ----
px, py, pw = 268, 64, 426
ph = 572
rounded((px, py, px + pw, py + ph), 14, CARD, (72, 76, 90), 1)

x = px + 18
right = px + pw - 18
y = py + 16

text((x, y), "可用余额", f_label, DIM)
text((x, y + 20), "¥120.00", f_value, ACCENT)
text((right - 150, y + 22), "全部 3241万 · 本会话 346万", f_small, DIM)

y += 66
text((x, y), "DEEPSEEK_API_KEY", f_small, DIM)
text((x, y + 15), "充值 ¥120.00 · api.deepseek.com", f_small, DIM_2)

y += 34
rounded((x, y, right, y + 8), 4, TRACK)
rounded((x, y, x + int((right - x) * 0.17), y + 8), 4, ACCENT)
text((x, y + 12), "已用 4.4万 / 26.2万 · 17%", f_tiny, DIM_2)
text((right, y + 12), "剩余 21.8万", f_tiny, DIM_2, anchor="ra")

y += 34
text((x, y), "全部会话", f_label, DIM)
y += 18
for label, val in [
    ("会话数", "6 / 6"),
    ("合计 tokens", "3241万"),
    ("输入（未缓存）", "20万"),
    ("缓存读取（命中）", "3200万"),
    ("输出", "20万"),
    ("缓存命中率", "99%"),
]:
    text((x, y), label, f_small, DIM_2)
    value(right, y, val)
    y += 17

y += 6
text((x, y), "本会话", f_label, DIM)
y += 18
for label, val in [("输入（未缓存）", "4,321"), ("缓存读取（命中）", "3,400,000"), ("输出", "56,000"), ("合计", "346万")]:
    text((x, y), label, f_small, DIM_2)
    value(right, y, val)
    y += 17

y += 6
text((x, y), "API Key 清单", f_label, DIM)
y += 18
keys = [
    ("DEEPSEEK_API_KEY", "deepseek-flash", "¥120.00", True),
    ("MOONSHOT_API_KEY", "kimi-k2, kimi-k2-0905", "¥45.00", False),
]
for name, models, amount, current in keys:
    tx = x
    if current:
        rounded((x, y - 1, x + 40, y + 13), 999, (28, 52, 44))
        text((x + 7, y + 1), "当前", f_tiny, GREEN)
        tx = x + 46
    text((tx, y), name, f_small, TEXT)
    value(right, y, amount)
    y += 14
    text((tx, y), models, f_tiny, DIM_2)
    text((tx, y + 11), "sk-xxxx…xxxx", f_tiny, DIM_2)
    y += 28

y += 2
text((x, y), "颜色", f_tiny, DIM_2)
for i, color in enumerate([ACCENT, (0, 168, 107), (245, 158, 11), (239, 68, 68), (139, 92, 246), (14, 165, 233)]):
    cx = x + 58 + i * 22
    d.ellipse([cx * S, (y - 1) * S, (cx + 14) * S, (y + 13) * S], fill=color)
d.ellipse([(x + 58) * S, (y - 1) * S, (x + 72) * S, (y + 13) * S], outline=TEXT, width=S)

y += 24
text((x, y), "面板透明度", f_tiny, DIM_2)
sx = x + 76
rounded((sx, y + 3, sx + 96, y + 9), 3, TRACK)
rounded((sx, y + 3, sx + 96, y + 9), 3, ACCENT)
d.ellipse([(sx + 96 - 6) * S, (y - 1) * S, (sx + 96 + 6) * S, (y + 13) * S], fill=ACCENT)
text((sx + 104, y), "100%", f_tiny, DIM)

y += 24
d.line([x * S, y * S, right * S, y * S], fill=(64, 68, 80), width=1)
y += 10
text((x, y), "token 来自宿主投影；余额来自 api.deepseek.com/user/balance", f_tiny, DIM_2)
y += 17
rounded((right - 118, y, right - 62, y + 22), 6, None, (86, 90, 104), 1)
text((right - 104, y + 4), "刷新", f_small, DIM)
rounded((right - 56, y, right, y + 22), 6, None, (86, 90, 104), 1)
text((right - 42, y + 4), "复制", f_small, DIM)

img = img.resize((W, H), Image.LANCZOS)
img.save(OUT)
print("wrote", OUT)
