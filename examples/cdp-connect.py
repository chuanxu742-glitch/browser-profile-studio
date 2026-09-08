import os
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(
        os.environ.get("CDP_URL", "http://127.0.0.1:9222"),
        headers={"Authorization": "Bearer " + os.environ.get("CDP_TOKEN", "")},
    )
    try:
        page = browser.contexts[0].new_page()
        page.goto(os.environ.get("TARGET_URL", "https://example.com"))
        print(page.title())
        page.close()
    finally:
        browser.close()
