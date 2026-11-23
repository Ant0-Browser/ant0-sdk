from ant0browser import launch


def main():
    browser = launch(identity={"mode": "native"})
    try:
        page = browser.new_page()
        page.goto("https://example.com")
        print(page.title())
    finally:
        browser.close()


if __name__ == "__main__":
    main()
