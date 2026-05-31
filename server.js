let currentUrl = "";

export default function handler(req, res) {

    if (req.method === "POST") {
        currentUrl = req.body.url;
        return res.json({ ok: true });
    }

    res.redirect(currentUrl);
}
