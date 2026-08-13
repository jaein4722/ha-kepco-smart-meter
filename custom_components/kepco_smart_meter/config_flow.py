"""설정 흐름 (설계문서 §19: YAML 편집을 요구하지 않는다).

두 단계로 받는다.

  1. 파워플래너 자격증명
  2. 계량기 앵커 — 전월지침. KEPCO 가 지침을 직접 주지 않으므로, 사용자가 한 번
     알려주면 이후 구간 합계를 더해 실제 계량기와 같은 축의 지침을 재구성한다(§26).

검침기준일은 물어보지 않는다. 청구 응답이 청구기간을 주므로 자동으로 도출된다.
"""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_PASSWORD
from homeassistant.core import callback
from homeassistant.helpers import selector

from .api import KepcoAuthError, KepcoClient, KepcoError
from .const import (
    CONF_ANCHOR_DATE,
    CONF_CUSTOMER_NUMBER,
    CONF_PREVIOUS_READING,
    CONF_USER_ID,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

CREDENTIALS_SCHEMA = vol.Schema(
    {vol.Required(CONF_USER_ID): str, vol.Required(CONF_PASSWORD): str}
)


class KepcoConfigFlow(ConfigFlow, domain=DOMAIN):
    """KEPCO 스마트미터 설정."""

    VERSION = 1

    def __init__(self) -> None:
        self._creds: dict[str, str] = {}
        self._customers: list = []
        self._billing = None

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            user_id = user_input[CONF_USER_ID].strip()
            client = KepcoClient(user_id, user_input[CONF_PASSWORD])
            try:
                await client.async_login()
                self._customers = await client.async_list_customers()
                self._billing = await client.async_get_billing_status()
            except KepcoAuthError:
                errors["base"] = "invalid_auth"
            except KepcoError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                _LOGGER.exception("설정 중 예상치 못한 오류")
                errors["base"] = "unknown"
            else:
                self._creds = {
                    CONF_USER_ID: user_id,
                    "password": user_input[CONF_PASSWORD],
                }
                return await self.async_step_meter()
            finally:
                await client.async_close()

        return self.async_show_form(
            step_id="user", data_schema=CREDENTIALS_SCHEMA, errors=errors
        )

    async def async_step_meter(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """계량기 앵커를 받는다."""
        numbers = [c.customer_number for c in self._customers] or [""]
        default_anchor = (
            self._billing.billing_start.isoformat()
            if self._billing and self._billing.billing_start
            else None
        )

        if user_input is not None:
            customer = user_input.get(CONF_CUSTOMER_NUMBER) or numbers[0]
            await self.async_set_unique_id(customer or self._creds[CONF_USER_ID])
            self._abort_if_unique_id_configured()
            return self.async_create_entry(
                title=f"KEPCO 스마트미터 ({customer})",
                data={
                    **self._creds,
                    CONF_CUSTOMER_NUMBER: customer,
                    CONF_PREVIOUS_READING: user_input.get(CONF_PREVIOUS_READING),
                    CONF_ANCHOR_DATE: user_input.get(CONF_ANCHOR_DATE) or default_anchor,
                },
            )

        schema: dict[Any, Any] = {}
        if len(numbers) > 1:
            schema[vol.Required(CONF_CUSTOMER_NUMBER, default=numbers[0])] = vol.In(numbers)
        schema[vol.Optional(CONF_PREVIOUS_READING)] = selector.NumberSelector(
            selector.NumberSelectorConfig(min=0, max=9_999_999, step=0.001, mode="box")
        )
        if default_anchor:
            schema[vol.Optional(CONF_ANCHOR_DATE, default=default_anchor)] = (
                selector.DateSelector()
            )

        period = ""
        if self._billing and self._billing.billing_start:
            period = f"{self._billing.billing_start} ~ {self._billing.billing_end}"

        return self.async_show_form(
            step_id="meter",
            data_schema=vol.Schema(schema),
            description_placeholders={"period": period},
        )

    async def async_step_reauth(self, entry_data: dict[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        entry = self._get_reauth_entry()

        if user_input is not None:
            client = KepcoClient(entry.data[CONF_USER_ID], user_input[CONF_PASSWORD])
            try:
                await client.async_login()
            except KepcoAuthError:
                errors["base"] = "invalid_auth"
            except KepcoError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(
                    entry, data_updates={"password": user_input[CONF_PASSWORD]}
                )
            finally:
                await client.async_close()

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema({vol.Required(CONF_PASSWORD): str}),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry) -> OptionsFlow:
        return KepcoOptionsFlow()


class KepcoOptionsFlow(OptionsFlow):
    """검침 후 전월지침을 갱신할 수 있게 한다."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)

        current = self.config_entry.options.get(
            CONF_PREVIOUS_READING, self.config_entry.data.get(CONF_PREVIOUS_READING)
        )
        schema = {
            vol.Optional(
                CONF_PREVIOUS_READING,
                description={"suggested_value": current},
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(min=0, max=9_999_999, step=0.001, mode="box")
            )
        }
        return self.async_show_form(step_id="init", data_schema=vol.Schema(schema))
