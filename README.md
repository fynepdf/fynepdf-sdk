# FynePDF SDKs

The [FynePDF API](https://fynepdf.com/developers/docs) for Node.js and Python: compress, convert, OCR, redact, merge, split and generate PDFs, and read them with AI. Both are typed from the API's own spec.

| Language | Install | Package | Folder |
|---|---|---|---|
| Node.js | `npm install fynepdf` | [fynepdf on npm](https://www.npmjs.com/package/fynepdf) | [node/](node/) |
| Python | `pip install fynepdf` | [fynepdf on PyPI](https://pypi.org/project/fynepdf/) | [python/](python/) |

Get a key at [fynepdf.com/developers](https://fynepdf.com/developers/dashboard). Test keys are free (results are watermarked); live keys get 250 free credits a month.

```js
import FynePDF from "fynepdf";

const fyne = new FynePDF(); // reads FYNEPDF_API_KEY
const file = await fyne.files.upload("./report.pdf");
const job = await fyne.pdf.compress({ file_id: file.id, target_size_bytes: 5_000_000 });
```

```python
from fynepdf import FynePDF

fyne = FynePDF()  # reads FYNEPDF_API_KEY
file = fyne.files.upload("report.pdf")
job = fyne.pdf.compress(file_id=file["id"], target_size_bytes=5_000_000)
```

Each folder's README has the full guide. `spec/` holds the API's OpenAPI document and action catalog that both SDKs are generated from.

For assistants (Claude, ChatGPT, Cursor and other MCP clients), see [fynepdf-mcp](https://github.com/fynepdf/fynepdf-mcp).

## License

[MIT](LICENSE)
