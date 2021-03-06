jest.mock("node-fetch");

import fetch from "node-fetch";
import { scrapeAPI as scraper } from "../api-scraper";
import * as helpers from "../../helpers";

const FAKE_VALID_AD_URL = "http://example.com/ad/123";

describe("Ad API scraper", () => {
    const fetchSpy = fetch as any as jest.Mock;

    afterEach(() => {
        jest.resetAllMocks();
    });

    const mockResponse = (body: string) => {
        fetchSpy.mockResolvedValue({
            text: () => body
        });
    };

    type MockAdInfo = {
        title?: string;
        description?: string;
        date?: Date;
        images?: string[];
        attributes?: any,
        price?: string;
        location?: string;
        type?: string;
        visits?: number;
    };

    const validateRequest = () => {
        expect(fetchSpy).toBeCalledWith(
            "https://mingle.kijiji.ca/api/ads/123",
            { compress: true, headers: {
                "User-Agent": "com.ebay.kijiji.ca 6.5.0 (samsung SM-G930U; Android 8.0.0; en_US)",
                "Accept-Language": "en-CA",
                Accept: "application/xml",
                Connection: "close",
                Pragma: "no-cache",
                Authorization: "Basic Y2FfYW5kcm9pZF9hcHA6YXBwQ2xAc3NpRmllZHMh",
                Host: "mingle.kijiji.ca",
                "Accept-Encoding": "gzip, deflate"
            }}
        );
    }

    const serializeAttribute = (name: string, value: any) => {
        return `
            <attr:attribute
                name="${name}"
                ${typeof value === "boolean" ? `localized-label=${value ? "Yes" : "No"}` : ""}
                ${value instanceof Date ? 'type="DATE"' : ""}
            >
                ${value !== undefined ?
                    `
                        <attr:value>
                        ${
                            value instanceof Date ? value.toISOString() :
                            typeof value === "string" ? value :
                            Number(value)
                        }
                        </attr:value>
                    `
                    : ""
                }
            </attr:attribute>
        `;
    };

    const createAdXML = (info: MockAdInfo) => {
        return `
            <ad:ad>
                ${info.title ? `<ad:title>${info.title}</ad:title>` : ""}
                ${info.description ? `<ad:description>${info.description}</ad:description>` : ""}
                ${info.date ? `<ad:creation-date-time>${info.date.toISOString()}</ad:creation-date-time>` : ""}
                <pic:pictures>
                    ${(info.images ? info.images.map(url => `<pic:picture><pic:link rel="normal" href="${url}"></pic:picture>`) : []).join("\n")}
                </pic:pictures>
                ${info.price ? `<ad:price><types:amount>${info.price}</types:amount></ad:price>` : ""}
                ${info.location ? `<ad:ad-address><types:full-address>${info.location}</types:full-address></ad:ad-address>` : ""}
                ${info.type ? `<ad:ad-type><ad:value>${info.type}</ad:value></ad:ad-type>` : ""}
                ${info.visits ? `<ad:view-ad-count>${info.visits}</ad:view-ad-count>` : ""}
                <attr:attributes>
                    ${info.attributes ? Object.entries(info.attributes).map(e => serializeAttribute(e[0], e[1])) : ""}
                </attr:attributes>
            </ad:ad>
        `;
    };

    it("should detect ban", async () => {
        fetchSpy.mockResolvedValue({ status: 403 });

        try {
            await scraper(FAKE_VALID_AD_URL);
            fail("Expected error for ban");
        } catch (err) {
            expect(err.message).toBe(
                "Kijiji denied access. You are likely temporarily blocked. This " +
                "can happen if you scrape too aggressively. Try scraping again later, " +
                "and more slowly. If this happens even when scraping reasonably, please " +
                "open an issue at: https://github.com/mwpenny/kijiji-scraper/issues"
            )
            validateRequest();
        }
    });

    it("should fail with invalid URL", async () => {
        try {
            await scraper("http://example.com")
            fail("Expected error for invalid URL");
        } catch (err) {
            expect(err.message).toBe("Invalid Kijiji ad URL. Ad URLs must end in /some-ad-id.");
        }
    });

    it.each`
        test                     | xml
        ${"Bad markup"}          | ${"Bad markup"}
        ${"Missing title"}       | ${createAdXML({})}
        ${"Missing date"}        | ${createAdXML({ title: "My ad title" })}
    `("should fail to scrape invalid XML ($test)", async ({ xml }) => {
        mockResponse(xml);

        const adInfo = await scraper(FAKE_VALID_AD_URL);
        validateRequest();
        expect(adInfo).toBeNull();
    });

    describe("valid markup", () => {
        it("should scrape title", async () => {
            mockResponse(createAdXML({
                title: "My ad title",
                description: "My ad description",
                date: new Date()
            }));

            const adInfo = await scraper(FAKE_VALID_AD_URL);
            validateRequest();
            expect(adInfo).not.toBeNull();
            expect(adInfo!.title).toBe("My ad title");
        });

        it.each`
            test         | description            | expected
            ${"missing"} | ${undefined}           | ${""}
            ${"present"} | ${"My ad description"} | ${"My ad description"}
        `("should scrape description ($test)", async ({ description, expected }) => {
            const cleanAdDescriptionSpy = jest.spyOn(helpers, "cleanAdDescription");
            cleanAdDescriptionSpy.mockReturnValueOnce("Clean description");

            mockResponse(createAdXML({
                title: "My ad title",
                description,
                date: new Date()
            }));

            const adInfo = await scraper(FAKE_VALID_AD_URL);
            validateRequest();
            expect(cleanAdDescriptionSpy).toBeCalledWith(expected);
            expect(adInfo).not.toBeNull();
            expect(adInfo!.description).toBe("Clean description");

            cleanAdDescriptionSpy.mockRestore();
        });

        it("should scrape date", async () => {
            const date = new Date();
            mockResponse(createAdXML({
                title: "My ad title",
                description: "My ad description",
                date
            }));

            const adInfo = await scraper(FAKE_VALID_AD_URL);
            validateRequest();
            expect(adInfo).not.toBeNull();
            expect(adInfo!.date).toEqual(date);
        });

        it.each`
            test                 | urls                    | expectedURL
            ${"no images"}       | ${undefined}            | ${""}
            ${"empty images"}    | ${[]}                   | ${""}
            ${"one image"}       | ${["image1"]}           | ${"image1"}
            ${"multiple images"} | ${["image1", "image2"]} | ${"image1"}
        `("should scrape image ($test)", async ({ urls, expectedURL }) => {
            const getLargeImageURLSpy = jest.spyOn(helpers, "getLargeImageURL");
            getLargeImageURLSpy.mockImplementation(url => url + "_large");

            mockResponse(createAdXML({
                title: "My ad title",
                description: "My ad description",
                date: new Date(),
                images: urls
            }));

            const adInfo = await scraper(FAKE_VALID_AD_URL);
            validateRequest();
            expect(adInfo).not.toBeNull();
            expect(adInfo!.image).toBe(expectedURL ? expectedURL + "_large" : expectedURL);

            getLargeImageURLSpy.mockRestore();
        });

        it("should scrape images", async () => {
            const getLargeImageURLSpy = jest.spyOn(helpers, "getLargeImageURL");
            getLargeImageURLSpy.mockImplementation(url => url + "_large");

            mockResponse(createAdXML({
                title: "My ad title",
                description: "My ad description",
                date: new Date(),
                images: [
                    // Invalid,
                    "",

                    // Valid
                    "http://example.com/image",
                    "http://example.com/images/$_12.JPG",
                    "http://example.com/images/$_34.PNG"
                ]
            }));

            const adInfo = await scraper(FAKE_VALID_AD_URL);
            validateRequest();
            expect(getLargeImageURLSpy).toBeCalledTimes(3);
            expect(adInfo).not.toBeNull();
            expect(adInfo!.images).toEqual([
                "http://example.com/image_large",
                "http://example.com/images/$_12.JPG_large",
                "http://example.com/images/$_34.PNG_large"
            ]);

            getLargeImageURLSpy.mockRestore();
        });

        it.each`
            test               | value
            ${"undefined"}     | ${undefined}
            ${"true boolean"}  | ${true}
            ${"false boolean"} | ${false}
            ${"integer"}       | ${123}
            ${"float"}         | ${1.21}
            ${"date"}          | ${new Date("2020-09-06T20:52:47.474Z")}
            ${"string"}        | ${"hello"}
        `("should scrape attribute ($test)", async ({ value }) => {
            mockResponse(createAdXML({
                title: "My ad title",
                description: "My ad description",
                date: new Date(),
                attributes: {
                    myAttr: value
                }
            }));

            const adInfo = await scraper(FAKE_VALID_AD_URL);
            validateRequest();
            expect(adInfo).not.toBeNull();
            expect(adInfo!.attributes).toEqual({
                myAttr: value
            });
        });

        it.each`
            test                    | value        | expected
            ${"no amount"}          | ${undefined} | ${undefined}
            ${"non-numeric amount"} | ${"abc"}     | ${undefined}
            ${"with amount"}        | ${1.23}      | ${1.23}
        `("should scrape price ($test)", async ({ value, expected }) => {
            mockResponse(createAdXML({
                title: "My ad title",
                description: "My ad description",
                date: new Date(),
                price: value
            }));

            const adInfo = await scraper(FAKE_VALID_AD_URL);
            validateRequest();
            expect(adInfo).not.toBeNull();
            expect(adInfo!.attributes.price).toBe(expected);
        });

        it("should scrape location", async () => {
            mockResponse(createAdXML({
                title: "My ad title",
                description: "My ad description",
                date: new Date(),
                location: "Some location"
            }));

            const adInfo = await scraper(FAKE_VALID_AD_URL);
            validateRequest();
            expect(adInfo).not.toBeNull();
            expect(adInfo!.attributes.location).toBe("Some location");
        });

        it("should scrape type", async () => {
            mockResponse(createAdXML({
                title: "My ad title",
                description: "My ad description",
                date: new Date(),
                type: "Some type"
            }));

            const adInfo = await scraper(FAKE_VALID_AD_URL);
            validateRequest();
            expect(adInfo).not.toBeNull();
            expect(adInfo!.attributes.type).toBe("Some type");
        });

        it("should scrape visits", async () => {
            mockResponse(createAdXML({
                title: "My ad title",
                description: "My ad description",
                date: new Date(),
                visits: 12345
            }));

            const adInfo = await scraper(FAKE_VALID_AD_URL);
            validateRequest();
            expect(adInfo).not.toBeNull();
            expect(adInfo!.attributes.visits).toBe(12345);
        });
    });
});