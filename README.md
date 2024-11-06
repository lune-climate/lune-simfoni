# Lune/Simfoni CSV tool

This tool estimates the emission of a search term and category from a CSV and outputs a new CSV.

This project is written in Typescript and calls the Lune API for each row in the CSV.

Use as inpiration for an integration.

The file `template.csv` has been included as a template.

## Using lune-simfoni-csv-tool

First, ensure you've created an API Key: https://dashboard.lune.co/developers.

**Dependencies**: `nvm` and `yarn` must be installed in your system.

then:

* Use the correct node version (requires `nvm`): `nvm use`
* Install dependencies (requires `yarn`): `yarn`
* Build the tool: `yarn build`
* Run the tool: `API_KEY=$API_KEY yarn tool [options] <filename>`, for example:
    ```
    API_KEY=$API_KEY yarn tool -s 'Category Level 3' -ca 'Category Level 2' -m 'Sum of Spend' -cu Currency -c Country -o output.csv template.csv
    ```

    The script now accepts a comma separated list of search terms and category and calculates emissions for all permutations:
    ```
    yarn tool -s 'Category Level 3, Category Level 2' -ca 'Category Level 2, Category Level 1' -m 'Sum of Spend' -cu Currency -c Country -o output.csv template.csv
    ```

* For usage: `yarn tool --help`
