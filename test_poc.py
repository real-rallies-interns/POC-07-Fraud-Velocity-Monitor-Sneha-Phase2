"""
========================================================
  Selenium UAT Script — Fraud Velocity Monitor PoC
  Architect : Sneha Sunilkumar
  Batch     : Batch 2 Interns
  Stack     : Next.js, FastAPI, Tailwind CSS, Recharts
========================================================
  Run: python test_poc.py
  Output: Test_Report.txt
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.action_chains import ActionChains
from selenium.common.exceptions import TimeoutException
from datetime import datetime
import time

# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────
TARGET_URL   = "https://poc-fraud-velocity-monitor.victoriouspebble-4f5f6ab7.centralindia.azurecontainerapps.io"
ARCHITECT    = "Sneha Sunilkumar"
WAIT_TIMEOUT = 25
report_lines = []

def log(msg):
    print(msg)
    report_lines.append(msg)

# ─────────────────────────────────────────────
# SETUP DRIVER
# ─────────────────────────────────────────────
def create_driver():
    options = Options()
    options.add_argument("--start-maximized")
    options.add_argument("--disable-notifications")
    options.add_argument("--log-level=3")
    driver = webdriver.Chrome(options=options)
    return driver

# ─────────────────────────────────────────────
# TEST CASE 1 — Visual Load
# ─────────────────────────────────────────────
def test_case_1_visual_load(driver, wait):
    log("\n──────────────────────────────────────────")
    log("TEST CASE 1 : Visual Load")
    log("──────────────────────────────────────────")
    try:
        driver.get(TARGET_URL)
        log(f"  ➜ Navigated to: {TARGET_URL}")

        infocreon_brand = wait.until(
            EC.presence_of_element_located((By.XPATH, "//*[contains(text(), 'INFOCREON')]"))
        )
        log(f"  ✔ INFOCREON header brand found: '{infocreon_brand.text}'")

        body_bg = driver.execute_script(
            "return window.getComputedStyle(document.body).backgroundColor;"
        )
        log(f"  ✔ Background color detected: {body_bg}")

        metric_labels = ["TOTAL TXNS", "FRAUD DETECTED", "FRAUD RATE", "ANOMALY BURSTS", "PEAK VELOCITY"]
        page_source = driver.page_source
        found_metrics = [m for m in metric_labels if m in page_source]
        log(f"  ✔ Metric strip items found: {found_metrics}")

        if len(found_metrics) >= 3:
            log("  ✔ RESULT : PASS")
            return "PASS"
        else:
            log("  ✘ RESULT : FAIL — Metric strip not fully visible")
            return "FAIL"

    except TimeoutException:
        log("  ✘ RESULT : FAIL — Page did not load within timeout")
        return "FAIL"
    except Exception as e:
        log(f"  ✘ RESULT : FAIL — {e}")
        return "FAIL"

# ─────────────────────────────────────────────
# TEST CASE 2 — The Handshake (Slide Panel)
# ─────────────────────────────────────────────
def test_case_2_handshake_panel(driver, wait):
    log("\n──────────────────────────────────────────")
    log("TEST CASE 2 : The Handshake (Slide Panel)")
    log("──────────────────────────────────────────")
    try:
        # Wait for recharts to render
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".recharts-wrapper")))
        log("  ✔ Recharts chart container found")
        time.sleep(3)  # Allow data to fully load

        # Strategy 1: Click SVG polygon anomaly triangles directly
        polygons = driver.find_elements(By.CSS_SELECTOR, "polygon")
        log(f"  ➜ Found {len(polygons)} polygon elements (anomaly triangles)")

        for i, poly in enumerate(polygons[:8]):
            try:
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", poly)
                time.sleep(0.3)
                ActionChains(driver).move_to_element(poly).click().perform()
                time.sleep(2)
                panel = driver.find_elements(By.CSS_SELECTOR, ".slide-panel.open")
                if panel:
                    log(f"  ✔ Polygon #{i+1} clicked — slide panel opened!")
                    log("  ✔ RESULT : PASS")
                    return "PASS"
            except Exception:
                continue

        # Strategy 2: Click recharts-surface (the SVG canvas) at anomaly position
        log("  ⚠ Polygon click failed — trying recharts surface click...")
        surfaces = driver.find_elements(By.CSS_SELECTOR, ".recharts-surface")
        for surface in surfaces[:2]:
            try:
                size = surface.size
                loc  = surface.location
                # Click at 60% x, 30% y — typical anomaly spike area
                x_offset = int(size['width']  * 0.60)
                y_offset = int(size['height'] * 0.30)
                ActionChains(driver).move_to_element_with_offset(
                    surface, x_offset, y_offset
                ).click().perform()
                time.sleep(2)
                panel = driver.find_elements(By.CSS_SELECTOR, ".slide-panel.open")
                if panel:
                    log("  ✔ Surface click worked — slide panel opened!")
                    log("  ✔ RESULT : PASS")
                    return "PASS"
            except Exception:
                continue

        # Strategy 3: Trigger click via JavaScript on first polygon
        log("  ⚠ Surface click failed — trying JS dispatchEvent...")
        polygons = driver.find_elements(By.CSS_SELECTOR, "polygon")
        for poly in polygons[:5]:
            try:
                driver.execute_script("""
                    var evt = new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    });
                    arguments[0].dispatchEvent(evt);
                """, poly)
                time.sleep(2)
                panel = driver.find_elements(By.CSS_SELECTOR, ".slide-panel.open")
                if panel:
                    log("  ✔ JS dispatchEvent worked — slide panel opened!")
                    log("  ✔ RESULT : PASS")
                    return "PASS"
            except Exception:
                continue

        log("  ✘ RESULT : FAIL — Could not trigger slide panel after all strategies")
        log("  💡 TIP: Check your app is showing anomaly data points (try different time resolution)")
        return "FAIL"

    except TimeoutException:
        log("  ✘ RESULT : FAIL — Chart not found within timeout")
        return "FAIL"
    except Exception as e:
        log(f"  ✘ RESULT : FAIL — {e}")
        return "FAIL"

# ─────────────────────────────────────────────
# TEST CASE 3 — The Signature (Info Modal)
# ─────────────────────────────────────────────
def test_case_3_signature(driver, wait):
    log("\n──────────────────────────────────────────")
    log("TEST CASE 3 : The Signature (Info Modal)")
    log("──────────────────────────────────────────")
    try:
        # Close slide panel first if it's open (it may cover the info button)
        close_btns = driver.find_elements(By.XPATH, "//button[@title='Close panel']")
        if close_btns:
            driver.execute_script("arguments[0].click();", close_btns[0])
            log("  ✔ Slide panel closed before clicking info button")
            time.sleep(1)

        info_button = wait.until(
            EC.presence_of_element_located((By.XPATH, "//button[@title='Architect Info']"))
        )
        log("  ✔ Info button (ⓘ) found")
        # Use JS click to bypass any overlay interception
        driver.execute_script("arguments[0].click();", info_button)
        log("  ✔ Info button clicked")

        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".info-modal-overlay")))
        log("  ✔ Info modal overlay appeared")

        modal = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".info-modal")))
        modal_text = modal.text
        log(f"  ✔ Modal content:\n{modal_text}")

        if ARCHITECT in modal_text:
            log(f"  ✔ Architect name '{ARCHITECT}' found in modal!")
            log("  ✔ RESULT : PASS")
            return "PASS"
        else:
            log(f"  ✘ RESULT : FAIL — '{ARCHITECT}' not found in modal")
            return "FAIL"

    except TimeoutException:
        log("  ✘ RESULT : FAIL — Info modal did not appear within timeout")
        return "FAIL"
    except Exception as e:
        log(f"  ✘ RESULT : FAIL — {e}")
        return "FAIL"

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    log("========================================================")
    log("  UAT TEST REPORT — Fraud Velocity Monitor PoC")
    log(f"  Architect : {ARCHITECT}")
    log(f"  URL       : {TARGET_URL}")
    log(f"  Run Time  : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    log("========================================================")

    driver  = create_driver()
    wait    = WebDriverWait(driver, WAIT_TIMEOUT)
    results = {}

    try:
        results["Test Case 1 - Visual Load"]       = test_case_1_visual_load(driver, wait)
        results["Test Case 2 - Handshake (Panel)"] = test_case_2_handshake_panel(driver, wait)
        results["Test Case 3 - Signature (Modal)"] = test_case_3_signature(driver, wait)
    finally:
        driver.quit()
        log("\n  Browser closed.")

    log("\n========================================================")
    log("  FINAL SUMMARY")
    log("========================================================")
    all_pass = True
    for name, result in results.items():
        icon = "✔ PASS" if result == "PASS" else "✘ FAIL"
        log(f"  {icon}  —  {name}")
        if result != "PASS":
            all_pass = False

    overall = "✅ ALL TESTS PASSED — Ready for Level 2 Submission!" if all_pass else "❌ SOME TESTS FAILED — Review above logs."
    log(f"\n  OVERALL: {overall}")
    log("========================================================")

    with open("Test_Report.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(report_lines))
    print("\n  📄 Test_Report.txt saved successfully!")

if __name__ == "__main__":
    main()
