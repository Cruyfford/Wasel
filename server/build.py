# يجمع واجهة التطبيق من src/ في ملف app.html واحد
import pathlib
d = pathlib.Path(__file__).parent / "src"
css = (d / "base.css").read_text() + (d / "extra.css").read_text()
icons = (d / "icons.svg").read_text()
gear = '''  <symbol id="i-gear" viewBox="0 0 24 24"><path d="M19.4 13c.04-.33.06-.66.06-1s-.02-.67-.06-1l2.1-1.65c.2-.15.25-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.33-.07.67-.07 1s.03.67.07 1l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64L19.4 13zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/></symbol>
'''
if "i-gear" not in icons:
    icons = icons.replace("</svg>", gear + "</svg>", 1)
html = f'''<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#07090f">
<title>واصل</title>
<style>{css}</style>
</head>
<body>
{icons}
{(d / "body.html").read_text()}
<script>
{(d / "app.js").read_text()}
</script>
</body>
</html>
'''
(d.parent / "app.html").write_text(html)
print("app.html", len(html))
