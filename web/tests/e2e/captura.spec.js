import { expect, test } from "@playwright/test";

test("A) viaje buttons no aparecen sin viaje activo", async ({ page }) => {
  await page.route("**/api/expense-capture-context", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        methods: [{ id: "m1", label: "Amex" }],
        hasTrip: false,
        activeTripId: null
      })
    });
  });

  await page.goto("/dashboard/captura");

  await expect(page.getByText("Es del viaje")).toHaveCount(0);
  await expect(page.getByText("No es del viaje")).toHaveCount(0);
});

test("B) lista métodos cuando existen", async ({ page }) => {
  await page.route("**/api/expense-capture-context", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        methods: [
          { id: "m1", label: "Amex" },
          { id: "m2", label: "BBVA" }
        ],
        hasTrip: false,
        activeTripId: null
      })
    });
  });

  await page.route("**/api/expense-draft", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        draft: { amount: 100, description: "uber", rawText: "100 uber" }
      })
    });
  });

  await page.goto("/dashboard/captura");
  await page.getByLabel("captura-input").fill("100 uber");
  await page.getByRole("button", { name: "Enviar" }).click();

  await expect(page.getByRole("button", { name: "Amex" })).toBeVisible();
  await expect(page.getByRole("button", { name: "BBVA" })).toBeVisible();
  await expect(page.getByText("No encontramos métodos")).toHaveCount(0);
  await expect(page.getByText("Sin métodos")).toHaveCount(0);
});

test("C) happy path draft -> método -> confirmar -> reset", async ({ page }) => {
  await page.route("**/api/expense-capture-context", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        methods: [{ id: "m1", label: "Amex" }],
        hasTrip: false,
        activeTripId: null
      })
    });
  });

  await page.route("**/api/expense-draft", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        draft: { amount: 100, description: "uber", rawText: "100 uber" }
      })
    });
  });

  await page.route("**/api/expenses", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });

  await page.goto("/dashboard/captura");
  await page.getByLabel("captura-input").fill("100 uber");
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByRole("button", { name: "Amex" }).click();
  await page.getByRole("button", { name: "Confirmar" }).click();

  await expect(page.getByText("guardado")).toBeVisible();
  await expect(page.getByLabel("captura-input")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Confirmar" })).toHaveCount(0);
});
